import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { entryTerms, firstMonthOpenings, type OpeningBalances } from "@/lib/entries";
import { computeEntry, MANUAL_FIELDS, type ManualInputs } from "@/lib/ledger";
import { OPENING_COLUMNS } from "@/lib/members";
import { isCents } from "@/lib/money";
import { audit, check, getOpenPeriod, HttpError, readJson, requireUser, route } from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Set the balances an existing member brought into the system. Allowed only
 * until the member's first month is rolled; after that the roll carries the
 * balances and nobody can type them.
 */
export const PUT = route(async (req: Request, { params }: Ctx) => {
  const s = await requireUser();
  const { id } = await params;
  const body = await readJson(req);
  const next = {} as OpeningBalances;
  for (const k of OPENING_COLUMNS) {
    if (!isCents(body[k])) throw new HttpError(400, "One of the opening balances is not valid.");
    next[k] = body[k] as number;
  }

  const before = check(await db().from("members").select("*").eq("id", id).maybeSingle());
  if (!before) throw new HttpError(404, "Member not found.");
  const { count } = await db()
    .from("member_entries")
    .select("id, periods!inner(status)", { count: "exact", head: true })
    .eq("member_id", id)
    .eq("periods.status", "closed");
  if (count) throw new HttpError(422, "This member's first month has been rolled, so their balances are now carried by the roll and cannot be changed.");

  // if the member already has a row in the open month, recalculate it with the new balances b/f
  const open = await getOpenPeriod();
  const entry = open
    ? check(await db().from("member_entries").select("*").eq("period_id", open.id).eq("member_id", id).maybeSingle())
    : null;
  let entryUpdate: Record<string, unknown> | null = null;
  if (entry) {
    const openings = firstMonthOpenings(next, entry.bonus_credit);
    const inputs = Object.fromEntries(MANUAL_FIELDS.map((k) => [k, entry[k]])) as unknown as ManualInputs;
    const { computed, errors } = computeEntry(openings, inputs, await entryTerms(open!, id));
    if (errors.length) {
      throw new HttpError(422, `With these balances this month's figures no longer work: ${errors.join(" ")} Correct the month's figures first.`);
    }
    const { bonus_credit: _same, ...openingColumns } = openings;
    entryUpdate = { ...openingColumns, ...computed, version: entry.version + 1, updated_at: new Date().toISOString(), updated_by: s.username };
  }

  check(await db().from("members").update(next).eq("id", id));
  if (entry && entryUpdate) {
    const saved = check(
      await db().from("member_entries").update(entryUpdate).eq("id", entry.id).eq("version", entry.version).select("id").maybeSingle(),
    );
    if (!saved) {
      check(await db().from("members").update(Object.fromEntries(OPENING_COLUMNS.map((k) => [k, before[k]]))).eq("id", id));
      throw new HttpError(409, "This member's monthly record was being changed at the same time. Try again.");
    }
  }
  await audit(s, "opening_balances_set", {
    member_id: id,
    changes: Object.fromEntries(OPENING_COLUMNS.map((k) => [k, { from: before[k], to: next[k] }])),
  });
  return NextResponse.json({ ok: true });
});
