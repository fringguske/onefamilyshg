// The accounting rules of the group, in one place.
// Used by the browser (live preview while feeding) and by the server (the
// figures that are actually saved). The database re-checks every identity.
import { formatMoney, isCents } from "./money";

/** Values carried into the month by the roll (or typed once as opening balances). */
export interface Openings {
  savings_open: number;
  advance_bal_open: number;
  advance_interest_bf: number;
  advance_interest_charged: number;
  bonus_credit: number;
}

/** Values the chairman feeds each month. */
export interface ManualInputs {
  amount_paid: number;
  advance_repaid: number;
  advance_issued: number;
  mgr_contribution: number;
}

/** Values the computer works out. */
export interface Computed {
  advance_interest_paid: number;
  advance_interest_deducted: number;
  savings_contribution: number;
  savings_close: number;
  advance_bal_close: number;
  advance_interest_arrears: number;
}

/** Group terms that apply when a record is saved. */
export interface Terms {
  advance_rate_bps: number;
  /** the merry go round amount this member is expected to give (0 for the month's recipient) */
  mgr_due: number;
}

export const MANUAL_FIELDS = ["amount_paid", "advance_repaid", "advance_issued", "mgr_contribution"] as const;

/** rate x balance, rounded half-up to the cent. Same formula as interest_on() in SQL. */
export function interestOn(balanceCents: number, rateBps: number): number {
  return Number((BigInt(balanceCents) * BigInt(rateBps) + 5000n) / 10000n);
}

export function interestDue(o: Openings): number {
  return o.advance_interest_bf + o.advance_interest_charged;
}

/** What the member is expected to bring this month: interest due, the whole advance b/f and the merry go round. */
export function expectedAmount(o: Openings, mgrDue: number): number {
  return interestDue(o) + o.advance_bal_open + mgrDue;
}

/**
 * How the chairman's sheet fills the advance repayment and merry go round
 * when an amount brought is typed: if it covers what is expected, both are
 * taken in full and the rest is savings; if it is short, all of it is savings.
 * The chairman can change either amount afterwards.
 */
export function autoSplit(o: Openings, amountPaid: number, mgrDue: number) {
  const covered = amountPaid >= expectedAmount(o, mgrDue);
  return { advance_repaid: covered ? o.advance_bal_open : 0, mgr_contribution: covered ? mgrDue : 0 };
}

/**
 * Splits the cash a member brought:
 *   1. advance interest (incl. unpaid interest from earlier months), but only
 *      when the member brought everything expected or is repaying the advance
 *   2. the advance repayment and merry go round contribution
 *   3. whatever is left becomes savings
 * Unpaid interest is carried forward as arrears (it is not added to the
 * advance, so it never compounds).
 * Interest on a new advance is cut when it is issued: the member owes the
 * whole advance but receives it less the interest.
 */
export function computeEntry(o: Openings, m: ManualInputs, t: Terms): { computed: Computed; errors: string[] } {
  const errors: string[] = [];
  for (const k of MANUAL_FIELDS) {
    if (!isCents(m[k])) errors.push(`Invalid amount in ${label(k)}.`);
  }
  if (errors.length) return { computed: emptyComputed(o), errors };

  const due = interestDue(o);
  const covered = m.amount_paid >= expectedAmount(o, t.mgr_due);
  const advance_interest_paid = covered || m.advance_repaid > 0 ? due : 0;
  const used = advance_interest_paid + m.advance_repaid + m.mgr_contribution;

  if (m.advance_repaid > o.advance_bal_open) {
    errors.push(`Advance repayment (${formatMoney(m.advance_repaid)}) is more than the advance balance (${formatMoney(o.advance_bal_open)}).`);
  }
  if (used > m.amount_paid) {
    const parts = [
      advance_interest_paid && `interest (${formatMoney(advance_interest_paid)})`,
      m.advance_repaid && `repayment (${formatMoney(m.advance_repaid)})`,
      m.mgr_contribution && `merry go round (${formatMoney(m.mgr_contribution)})`,
    ].filter(Boolean);
    errors.push(
      `Amount brought (${formatMoney(m.amount_paid)}) does not cover ${parts.join(" plus ")}. ` +
        `Short by ${formatMoney(used - m.amount_paid)}.`,
    );
  }
  const savings_contribution = Math.max(0, m.amount_paid - used);

  return {
    computed: {
      advance_interest_paid,
      advance_interest_deducted: interestOn(m.advance_issued, t.advance_rate_bps),
      savings_contribution,
      savings_close: o.savings_open + savings_contribution + o.bonus_credit,
      advance_bal_close: o.advance_bal_open + m.advance_issued - m.advance_repaid,
      advance_interest_arrears: due - advance_interest_paid,
    },
    errors,
  };
}

function emptyComputed(o: Openings): Computed {
  return {
    advance_interest_paid: 0,
    advance_interest_deducted: 0,
    savings_contribution: 0,
    savings_close: o.savings_open + o.bonus_credit,
    advance_bal_close: o.advance_bal_open,
    advance_interest_arrears: interestDue(o),
  };
}

/**
 * Shares a bonus out in whole cents so the shares always add up to the total
 * exactly (largest-remainder method). Weight = savings balance for a
 * savings-based share, or 1 each for an equal share. Ties go to the lower
 * member number, so the result is always the same for the same data.
 */
export function splitBonus(
  totalCents: number,
  members: { member_id: string; member_no: number; weight: number }[],
): { member_id: string; amount: number }[] {
  if (!members.length) return [];
  let rows = members.map((m) => ({ ...m, w: BigInt(Math.max(0, m.weight)) }));
  let weightSum = rows.reduce((a, r) => a + r.w, 0n);
  if (weightSum === 0n) {
    rows = rows.map((r) => ({ ...r, w: 1n }));
    weightSum = BigInt(rows.length);
  }
  const total = BigInt(totalCents);
  const parts = rows.map((r) => ({
    member_id: r.member_id,
    member_no: r.member_no,
    base: (total * r.w) / weightSum,
    rem: (total * r.w) % weightSum,
  }));
  let leftover = total - parts.reduce((a, p) => a + p.base, 0n);
  const order = [...parts].sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.member_no - b.member_no));
  for (const p of order) {
    if (leftover === 0n) break;
    p.base += 1n;
    leftover -= 1n;
  }
  return parts.map((p) => ({ member_id: p.member_id, amount: Number(p.base) }));
}

export function label(field: string): string {
  return (
    {
      amount_paid: "Amount brought",
      advance_repaid: "Advance repaid",
      advance_issued: "New advance issued",
      mgr_contribution: "Merry go round",
      savings_open: "Savings b/f",
      advance_bal_open: "Advance balance b/f",
    } as Record<string, string>
  )[field] ?? field;
}
