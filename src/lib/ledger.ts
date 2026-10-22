// The accounting rules of the group, in one place.
// Used by the browser (live preview while feeding) and by the server (the
// figures that are actually saved). The database re-checks every identity.
import { formatMoney, isCents } from "./money";

/** Values carried into the month by the roll (or typed once as opening balances). */
export interface Openings {
  savings_open: number;
  loan_bal_open: number;
  advance_bal_open: number;
  loan_interest_bf: number;
  advance_interest_bf: number;
  loan_interest_charged: number;
  advance_interest_charged: number;
  bonus_credit: number;
}

/** Values the chairman feeds each month. */
export interface ManualInputs {
  amount_paid: number;
  loan_repaid: number;
  advance_repaid: number;
  loan_issued: number;
  advance_issued: number;
}

/** Values the computer works out. */
export interface Computed {
  loan_interest_paid: number;
  advance_interest_paid: number;
  savings_contribution: number;
  savings_close: number;
  loan_bal_close: number;
  advance_bal_close: number;
  loan_interest_arrears: number;
  advance_interest_arrears: number;
}

/** Must be typed exactly before a bonus is issued. */
export const BONUS_CONFIRM_PHRASE = "ISSUE BONUS";

export const MANUAL_FIELDS = ["amount_paid", "loan_repaid", "advance_repaid", "loan_issued", "advance_issued"] as const;
export const OPENING_FIELDS = ["savings_open", "loan_bal_open", "advance_bal_open"] as const;

/** rate x balance, rounded half-up to the cent. Same formula as interest_on() in SQL. */
export function interestOn(balanceCents: number, rateBps: number): number {
  return Number((BigInt(balanceCents) * BigInt(rateBps) + 5000n) / 10000n);
}

export function interestDue(o: Openings) {
  const loan = o.loan_interest_bf + o.loan_interest_charged;
  const advance = o.advance_interest_bf + o.advance_interest_charged;
  return { loan, advance, total: loan + advance };
}

/**
 * Splits the cash a member brought:
 *   1. loan interest (incl. unpaid interest from earlier months)
 *   2. advance interest
 *   3. loan and advance repayments, as typed by the chairman
 *   4. whatever is left becomes savings
 * If the cash does not cover the interest, the unpaid interest is carried
 * forward as arrears (it is not added to the loan, so it never compounds).
 */
export function computeEntry(o: Openings, m: ManualInputs): { computed: Computed; errors: string[] } {
  const errors: string[] = [];
  for (const k of MANUAL_FIELDS) {
    if (!isCents(m[k])) errors.push(`Invalid amount in ${label(k)}.`);
  }
  if (errors.length) return { computed: emptyComputed(o), errors };

  const due = interestDue(o);
  const loan_interest_paid = Math.min(m.amount_paid, due.loan);
  let left = m.amount_paid - loan_interest_paid;
  const advance_interest_paid = Math.min(left, due.advance);
  left -= advance_interest_paid;

  if (m.loan_repaid > o.loan_bal_open) {
    errors.push(`Loan repayment (${formatMoney(m.loan_repaid)}) is more than the loan balance (${formatMoney(o.loan_bal_open)}).`);
  }
  if (m.advance_repaid > o.advance_bal_open) {
    errors.push(`Advance repayment (${formatMoney(m.advance_repaid)}) is more than the advance balance (${formatMoney(o.advance_bal_open)}).`);
  }
  const repayments = m.loan_repaid + m.advance_repaid;
  if (repayments > left) {
    errors.push(
      `Amount brought (${formatMoney(m.amount_paid)}) does not cover interest (${formatMoney(due.total)}) ` +
        `plus repayments (${formatMoney(repayments)}). Short by ${formatMoney(due.total + repayments - m.amount_paid)}.`,
    );
  }
  const savings_contribution = Math.max(0, left - repayments);

  return {
    computed: {
      loan_interest_paid,
      advance_interest_paid,
      savings_contribution,
      savings_close: o.savings_open + savings_contribution + o.bonus_credit,
      loan_bal_close: o.loan_bal_open + m.loan_issued - m.loan_repaid,
      advance_bal_close: o.advance_bal_open + m.advance_issued - m.advance_repaid,
      loan_interest_arrears: due.loan - loan_interest_paid,
      advance_interest_arrears: due.advance - advance_interest_paid,
    },
    errors,
  };
}

function emptyComputed(o: Openings): Computed {
  const due = interestDue(o);
  return {
    loan_interest_paid: 0,
    advance_interest_paid: 0,
    savings_contribution: 0,
    savings_close: o.savings_open + o.bonus_credit,
    loan_bal_close: o.loan_bal_open,
    advance_bal_close: o.advance_bal_open,
    loan_interest_arrears: due.loan,
    advance_interest_arrears: due.advance,
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
      loan_repaid: "Loan repaid",
      advance_repaid: "Advance repaid",
      loan_issued: "New loan issued",
      advance_issued: "New advance issued",
      savings_open: "Savings b/f",
      loan_bal_open: "Loan balance b/f",
      advance_bal_open: "Advance balance b/f",
    } as Record<string, string>
  )[field] ?? field;
}
