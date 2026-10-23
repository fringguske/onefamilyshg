import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { computeEntry, MANUAL_FIELDS, type ManualInputs, type Openings } from "@/lib/ledger";
import { isCents } from "@/lib/money";
import { audit, check, HttpError, readJson, requireUser, route, text } from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };
interface Body {
  version?: number;
  inputs?: Record<string, unknown>;
  notes?: string | null;
}

/**
 * Save one member's record for the open month. Only the manual fields are
 * taken from the browser; balances b/f come from the database (the roll, or
 * the member's opening balances) and can never be changed here.
 */
export const PUT = route(async (req: Request, { params }: Ctx) => {
  const s = await requireUser();
  const { id } = await params;
  const body = await readJson<Body>(req);

  const entry = check(await db().from("member_entries").select("*, period:periods!inner(id, seq, status, mgr_member_id)").eq("id", id).maybeSingle());
  if (!entry) throw new HttpError(404, "Record not found.");
  if (entry.period.status !== "open") throw new HttpError(422, "This month has been rolled, so its records are locked.");
  if (!Number.isInteger(body.version)) throw new HttpError(400, "Invalid request.");

  const inputs = {} as ManualInputs;
  for (const k of MANUAL_FIELDS) {
    const v = body.inputs?.[k] ?? 0;
    if (!isCents(v)) throw new HttpError(400, "One of the amounts is not valid.");
    inputs[k] = v;
  }
  if (inputs.mgr_contribution > 0 && entry.period.mgr_member_id === entry.member_id) {
    throw new HttpError(422, "This member takes the merry go round this month, so they do not contribute to it.");
  }

  const openings: Openings = {
    savings_open: entry.savings_open,
    advance_bal_open: entry.advance_bal_open,
    advance_interest_bf: entry.advance_interest_bf,
    advance_interest_charged: entry.advance_interest_charged,
    bonus_credit: entry.bonus_credit,
  };

  const { computed, errors } = computeEntry(openings, inputs);
  if (errors.length) throw new HttpError(422, errors.join(" "));

  const saved = check(
    await db()
      .from("member_entries")
      .update({
        ...inputs,
        ...computed,
        notes: text(body.notes, 300),
        version: entry.version + 1,
        updated_at: new Date().toISOString(),
        updated_by: s.username,
      })
      .eq("id", id)
      .eq("version", body.version!)
      .eq("bonus_credit", entry.bonus_credit)
      .select("*, member:members!inner(member_no, full_name, status)")
      .maybeSingle(),
  );
  if (!saved) {
    throw new HttpError(409, "Someone else changed this record while you were typing. Reload, check it, and save again.");
  }

  const changed = Object.fromEntries(
    MANUAL_FIELDS
      .filter((k) => entry[k] !== saved[k])
      .map((k) => [k, { from: entry[k], to: saved[k] }]),
  );
  if (Object.keys(changed).length) {
    await audit(s, "entry_saved", { entry_id: id, member_id: entry.member_id, period_id: entry.period_id, changed });
  }
  return NextResponse.json({ row: saved });
});
