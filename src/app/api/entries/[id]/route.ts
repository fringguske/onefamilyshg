import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { computeEntry, interestOn, MANUAL_FIELDS, OPENING_FIELDS, type ManualInputs, type Openings } from "@/lib/ledger";
import { isCents } from "@/lib/money";
import { audit, check, getSettings, HttpError, readJson, requireUser, route, text } from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };
interface Body {
  version?: number;
  inputs?: Record<string, unknown>;
  openings?: Record<string, unknown> | null;
  notes?: string | null;
}

/**
 * Save one member's record for the open month. The server recalculates
 * everything from the stored balances b/f; only the manual fields are taken
 * from the browser.
 */
export const PUT = route(async (req: Request, { params }: Ctx) => {
  const s = await requireUser();
  const { id } = await params;
  const body = await readJson<Body>(req);

  const entry = check(await db().from("member_entries").select("*, period:periods!inner(id, seq, status)").eq("id", id).maybeSingle());
  if (!entry) throw new HttpError(404, "Record not found.");
  if (entry.period.status !== "open") throw new HttpError(422, "This month has been rolled, so its records are locked.");
  if (!Number.isInteger(body.version)) throw new HttpError(400, "Invalid request.");

  const inputs = {} as ManualInputs;
  for (const k of MANUAL_FIELDS) {
    const v = body.inputs?.[k] ?? 0;
    if (!isCents(v)) throw new HttpError(400, "One of the amounts is not valid.");
    inputs[k] = v;
  }

  const openings: Openings = {
    savings_open: entry.savings_open,
    loan_bal_open: entry.loan_bal_open,
    advance_bal_open: entry.advance_bal_open,
    loan_interest_bf: entry.loan_interest_bf,
    advance_interest_bf: entry.advance_interest_bf,
    loan_interest_charged: entry.loan_interest_charged,
    advance_interest_charged: entry.advance_interest_charged,
    bonus_credit: entry.bonus_credit,
  };

  // Opening balances can only be typed in a member's first month (moving an
  // existing member's records into the system). After that the roll carries them.
  if (body.openings) {
    const { count } = await db()
      .from("member_entries")
      .select("id, periods!inner(seq)", { count: "exact", head: true })
      .eq("member_id", entry.member_id)
      .lt("periods.seq", entry.period.seq);
    if (count) throw new HttpError(422, "Balances b/f are carried by the roll and cannot be typed for this member.");
    for (const k of OPENING_FIELDS) {
      const v = body.openings[k] ?? 0;
      if (!isCents(v)) throw new HttpError(400, "One of the opening balances is not valid.");
      openings[k] = v;
    }
    const settings = await getSettings();
    openings.loan_interest_charged = interestOn(openings.loan_bal_open, settings.loan_rate_bps);
    openings.advance_interest_charged = interestOn(openings.advance_bal_open, settings.advance_rate_bps);
  }

  const { computed, errors } = computeEntry(openings, inputs);
  if (errors.length) throw new HttpError(422, errors.join(" "));

  const { bonus_credit: _unchanged, ...openingColumns } = openings;
  const saved = check(
    await db()
      .from("member_entries")
      .update({
        ...openingColumns,
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
    [...MANUAL_FIELDS, ...(body.openings ? OPENING_FIELDS : [])]
      .filter((k) => entry[k] !== saved[k])
      .map((k) => [k, { from: entry[k], to: saved[k] }]),
  );
  if (Object.keys(changed).length) {
    await audit(s, "entry_saved", { entry_id: id, member_id: entry.member_id, period_id: entry.period_id, changed });
  }
  return NextResponse.json({ row: saved });
});
