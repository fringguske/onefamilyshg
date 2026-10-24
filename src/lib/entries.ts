import "server-only";
import { db } from "./supabase";
import { computeEntry, type Openings, type Terms } from "./ledger";
import { check, getOpenPeriod, getSettings } from "./server";

export interface OpeningBalances {
  opening_savings_cents: number;
  opening_advance_cents: number;
}

const ZERO_INPUTS = { amount_paid: 0, advance_repaid: 0, advance_issued: 0, mgr_contribution: 0, fine_paid: 0, advance_interest_due: 0 };

/**
 * Balances b/f for a member's first month: their opening balances. The interest
 * on an opening advance was cut when it was taken, so it is simply due this month.
 */
export function firstMonthOpenings(m: OpeningBalances, bonus_credit = 0): Openings {
  return {
    savings_open: m.opening_savings_cents,
    advance_bal_open: m.opening_advance_cents,
    advance_interest_bf: 0,
    advance_interest_charged: 0,
    bonus_credit,
  };
}

/** The terms every member's record is worked out with. */
export async function entryTerms(): Promise<Terms> {
  const s = await getSettings();
  return { advance_rate_bps: s.advance_rate_bps, mgr_due: s.mgr_contribution_cents, fine_due: s.fine_cents };
}

/**
 * Makes sure every active member has a row in the open month.
 * A member with no earlier months starts from their opening balances;
 * anyone else (for example a member who was reactivated) starts from zero.
 */
export async function ensureOpenEntries(actor: string, onlyMemberIds?: string[]) {
  const open = await getOpenPeriod();
  if (!open) return;
  let q = db().from("members").select("id, opening_savings_cents, opening_advance_cents").eq("status", "active");
  if (onlyMemberIds) q = q.in("id", onlyMemberIds);
  const [members, existing, history, settings] = await Promise.all([
    q.then(check),
    db().from("member_entries").select("member_id").eq("period_id", open.id).then(check),
    db().rpc("members_with_history", { p_seq: open.seq }).then(check),
    getSettings(),
  ]);
  const have = new Set<string>(existing.map((e: { member_id: string }) => e.member_id));
  const hadMonths = new Set<string>(history as string[]);
  const zero: OpeningBalances = { opening_savings_cents: 0, opening_advance_cents: 0 };

  const rows = (members as ({ id: string } & OpeningBalances)[])
    .filter((m) => !have.has(m.id))
    .map((m) => {
      const openings = firstMonthOpenings(hadMonths.has(m.id) ? zero : m);
      const { bonus_credit: _none, ...openingColumns } = openings;
      return {
        period_id: open.id,
        member_id: m.id,
        ...openingColumns,
        ...computeEntry(openings, ZERO_INPUTS, { advance_rate_bps: settings.advance_rate_bps, mgr_due: 0, fine_due: 0 }).computed,
        updated_by: actor,
      };
    });
  if (rows.length) {
    check(await db().from("member_entries").upsert(rows, { onConflict: "period_id,member_id", ignoreDuplicates: true }));
  }
}
