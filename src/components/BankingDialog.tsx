"use client";
import { useEffect, useState } from "react";
import { Alert, Loading, Modal } from "@/components/ui";
import { api } from "@/lib/client";
import { formatMoney } from "@/lib/money";
import { monthLabel } from "@/lib/period";
import type { CostAccount, Period } from "@/lib/types";

/** What month_banking() in the database returns. */
interface Banking {
  first_month: boolean;
  banking_bf: number; banking_cf: number;
  fees: number; collected: number; savings: number; interest_paid: number; advances_repaid: number;
  mgr_collected: number; mgr_paid: number; mgr_recipient: string | null; fines: number;
  advances_issued: number; interest_cut: number; transaction_cost: number; transaction_cost_from: CostAccount; bonus_cash: number;
  bonus_credited: number; savings_bf: number; savings_cf: number; advances_bf: number; advances_cf: number;
  interest_due: number; interest_arrears: number; members: number; members_paid: number;
}

/** The floating "View this month banking" statement. */
export function BankingDialog({ period, unsaved, onClose }: { period: Period; unsaved: number; onClose: () => void }) {
  const [b, setB] = useState<Banking | null>(null);
  const [error, setError] = useState("");
  const label = monthLabel(period.year, period.month);

  useEffect(() => {
    api<{ banking: Banking }>(`/api/banking?period=${period.id}`).then((r) => setB(r.banking), (e) => setError(e.message));
  }, [period.id]);

  return (
    <Modal title={`Banking: ${label}`} onClose={onClose}>
      {error && <Alert kind="error">{error}</Alert>}
      {!b && !error && <Loading />}
      {b && <Statement b={b} />}
      {b && unsaved > 0 && (
        <Alert kind="warn">{unsaved} record(s) typed but not saved are not included. Save them to see them here.</Alert>
      )}
    </Modal>
  );
}

function Statement({ b }: { b: Banking }) {
  const banked = b.collected + b.fees;
  const handedOver = b.advances_issued - b.interest_cut;
  const paidOut = handedOver + b.mgr_paid + b.transaction_cost + b.bonus_cash;
  const interest = b.interest_paid + b.interest_cut + b.fines;
  const mgrHeld = b.mgr_collected - b.mgr_paid;
  const costFromFees = b.transaction_cost_from === "registration_fees";
  const interestCost = costFromFees ? 0 : b.transaction_cost;

  return (
    <div className="stack">
      <table className="statement">
        <tbody>
          <Line total label={b.first_month ? "Opening cash" : "Previous banking"} cents={b.banking_bf} />
          <Head>Banked this month</Head>
          <Line label="Savings" cents={b.savings} />
          <Line label="Advance repayments" cents={b.advances_repaid} />
          <Line label="Interest paid" cents={b.interest_paid} />
          <Line label="Merry go round contributions" cents={b.mgr_collected} />
          {b.fines > 0 && <Line label="Fines" cents={b.fines} />}
          {b.fees > 0 && <Line label="Registration fees" cents={b.fees} />}
          <Line total label="Total banked" cents={banked} />
          <Head>Paid out this month</Head>
          <Line
            label="New advances handed over"
            hint={b.interest_cut ? `${formatMoney(b.advances_issued)} issued, less ${formatMoney(b.interest_cut)} interest cut` : undefined}
            cents={handedOver}
          />
          <Line
            label={b.mgr_recipient ? `Merry go round to ${b.mgr_recipient}` : "Merry go round"}
            hint={mgrHeld ? `${formatMoney(mgrHeld)} kept in the bank until someone is chosen to take it` : undefined}
            cents={b.mgr_paid}
          />
          <Line
            label="Transaction costs"
            hint={b.transaction_cost ? `Paid from the ${costFromFees ? "registration fees" : "interest"}` : undefined}
            cents={b.transaction_cost}
          />
          {b.bonus_cash > 0 && <Line label="Bonuses paid in cash" cents={b.bonus_cash} />}
          <Line total label="Total paid out" cents={paidOut} />
          <Line grand label="Current banking" cents={b.banking_cf} />
        </tbody>
      </table>

      <table className="statement">
        <tbody>
          <Head>Advances</Head>
          <Line label="Owed at the start of the month" cents={b.advances_bf} />
          <Line label="Repaid" cents={b.advances_repaid} />
          <Line label="New advances issued" cents={b.advances_issued} />
          <Line total label="Owed at the end of the month" cents={b.advances_cf} />
          <Head>Interest</Head>
          <Line label="Interest due on advances" cents={b.interest_due} />
          <Line label="Interest paid" cents={b.interest_paid} />
          <Line label="Interest cut from new advances" cents={b.interest_cut} />
          {b.fines > 0 && <Line label="Fines" cents={b.fines} />}
          <Line label="Less transaction costs" cents={interestCost} />
          <Line total label={b.fines ? "Interest and fines after costs" : "Interest earned after costs"} cents={interest - interestCost} />
          {b.interest_arrears > 0 && <Line label="Unpaid interest carried forward" cents={b.interest_arrears} />}
          {costFromFees && b.transaction_cost > 0 && (
            <>
              <Head>Registration fees</Head>
              <Line label="Registration fees banked this month" cents={b.fees} />
              <Line label="Less transaction costs" cents={b.transaction_cost} />
              <Line total label="Registration fees after costs" cents={b.fees - b.transaction_cost} />
            </>
          )}
          <Head>Savings</Head>
          <Line label="Savings at the start of the month" cents={b.savings_bf} />
          <Line label="Savings added" cents={b.savings} />
          {b.bonus_credited > 0 && <Line label="Bonuses added to savings" cents={b.bonus_credited} />}
          <Line total label="Savings at the end of the month" cents={b.savings_cf} />
        </tbody>
      </table>
      <p className="muted small">{b.members_paid} of {b.members} member(s) brought money this month.</p>
    </div>
  );
}

function Head({ children }: { children: string }) {
  return <tr className="statement-head"><td colSpan={2}>{children}</td></tr>;
}

function Line({ label, cents, hint, total, grand }: { label: string; cents: number; hint?: string; total?: boolean; grand?: boolean }) {
  return (
    <tr className={grand ? "statement-grand" : total ? "statement-total" : undefined}>
      <td>
        {label}
        {hint && <div className="cell-hint">{hint}</div>}
      </td>
      <td className="num">{formatMoney(cents)}</td>
    </tr>
  );
}
