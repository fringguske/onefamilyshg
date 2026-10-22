"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Alert, Loading, Money, PageHeader, Stat } from "@/components/ui";
import { api } from "@/lib/client";
import { formatMoney as fmt, formatPercent } from "@/lib/money";
import { monthLabel } from "@/lib/period";
import type { Settings } from "@/lib/types";

interface MonthRow {
  id: string; seq: number; year: number; month: number; status: string; members: number; collected: number; interest: number;
  savings: number; loans_issued: number; loans_repaid: number; advances_issued: number; advances_repaid: number;
}
interface Summary {
  latest_period: { id: string; year: number; month: number; status: string } | null;
  total_savings: number; loans_outstanding: number; advances_outstanding: number; interest_arrears: number;
  total_collected: number; savings_contributed: number; loans_issued: number; loans_repaid: number;
  advances_issued: number; advances_repaid: number; loan_interest: number; advance_interest: number;
  opening_interest: number; total_interest: number; bonus_total: number; bonus_cash: number; bonus_pool_available: number;
  registration_fees: number; opening_cash: number; cash_at_hand: number; active_members: number; all_members: number;
  by_month: MonthRow[];
}

export default function SummaryPage() {
  const [data, setData] = useState<{ summary: Summary; settings: Settings } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ summary: Summary; settings: Settings }>("/api/summary").then(setData, (e) => setError(e.message));
  }, []);

  if (error) return <Alert kind="error">{error}</Alert>;
  if (!data) return <Loading />;
  const { summary: s, settings } = data;
  const cur = settings.currency;

  return (
    <div className="stack">
      <PageHeader
        title="Group summary"
        subtitle={
          s.latest_period
            ? <>Current month: <strong>{monthLabel(s.latest_period.year, s.latest_period.month)}</strong>. All amounts in {cur}. Loan interest {formatPercent(settings.loan_rate_bps)}% and advance interest {formatPercent(settings.advance_rate_bps)}% per month</>
            : "The books have not been started yet."
        }
        actions={<button className="btn btn-secondary no-print" onClick={() => window.print()}>Print</button>}
      />
      {!s.latest_period && (
        <Alert>Register the members, then open <Link href="/month">Monthly records</Link> to start the books.</Alert>
      )}

      <section className="stats">
        <Stat strong label="Total savings" cents={s.total_savings} hint="All members, incl. bonuses credited" />
        <Stat strong label="Total interest" cents={s.total_interest} hint={s.opening_interest ? `Incl. ${cur} ${fmt(s.opening_interest)} brought in` : "From loans and advances, goes to the group"} />
        <Stat strong label="Loans outstanding" cents={s.loans_outstanding} />
        <Stat strong label="Advances outstanding" cents={s.advances_outstanding} />
        <Stat label="Cash at hand" cents={s.cash_at_hand} hint="Opening cash + fees + collections - issues - cash bonuses" />
        <Stat label="Interest pool for bonus" cents={s.bonus_pool_available} hint="Interest from rolled months, less bonuses" />
        <Stat label="Bonuses issued" cents={s.bonus_total} />
        <Stat label="Registration fees" cents={s.registration_fees} />
        <Stat label="Loan interest" cents={s.loan_interest} />
        <Stat label="Advance interest" cents={s.advance_interest} />
        <Stat label="Unpaid interest (arrears)" cents={s.interest_arrears} hint="Carried forward to next month" />
        <Stat label="Total collected" cents={s.total_collected} hint="All cash brought by members" />
        <Stat label="Total loans issued" cents={s.loans_issued} hint={`Repaid ${fmt(s.loans_repaid)}`} />
        <Stat label="Total advances issued" cents={s.advances_issued} hint={`Repaid ${fmt(s.advances_repaid)}`} />
      </section>
      <p className="muted small">Members: {s.active_members} active of {s.all_members} registered.</p>

      {s.by_month.length > 0 && (
        <section>
          <h2>Month by month</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Month</th><th>Status</th><th className="num">Members</th><th className="num">Collected</th>
                  <th className="num">Interest</th><th className="num">Savings added</th><th className="num">Loans issued</th>
                  <th className="num">Loans repaid</th><th className="num">Advances issued</th><th className="num">Advances repaid</th>
                </tr>
              </thead>
              <tbody>
                {s.by_month.map((m) => (
                  <tr key={m.seq}>
                    <td><Link href={`/month?period=${m.id}`}>{monthLabel(m.year, m.month)}</Link></td>
                    <td><span className={`badge badge-${m.status}`}>{m.status === "open" ? "Open" : "Rolled"}</span></td>
                    <td className="num">{m.members}</td>
                    <td className="num"><Money cents={m.collected} /></td>
                    <td className="num"><Money cents={m.interest} /></td>
                    <td className="num"><Money cents={m.savings} /></td>
                    <td className="num"><Money cents={m.loans_issued} /></td>
                    <td className="num"><Money cents={m.loans_repaid} /></td>
                    <td className="num"><Money cents={m.advances_issued} /></td>
                    <td className="num"><Money cents={m.advances_repaid} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

