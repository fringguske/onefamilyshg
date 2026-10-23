"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Alert, Loading, Money, PageHeader, Stat } from "@/components/ui";
import { api } from "@/lib/client";
import { rotation } from "@/lib/mgr";
import { formatMoney } from "@/lib/money";
import { monthLabel } from "@/lib/period";

interface Month {
  id: string; year: number; month: number; seq: number; status: string; mgr_member_id: string | null; total: number; payers: number;
}
interface Member { id: string; member_no: number; full_name: string; status: string }
interface Data { months: Month[]; members: Member[]; contribution: number }

export default function MgrPage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Data>("/api/mgr").then(setData, (e) => setError(e.message));
  }, []);

  if (error) return <Alert kind="error">{error}</Alert>;
  if (!data) return <Loading />;

  const { months, members, contribution } = data;
  const byId = new Map(members.map((m) => [m.id, m]));
  const active = members.filter((m) => m.status === "active");
  const withRecipient = months
    .filter((m) => m.mgr_member_id)
    .map((m) => ({ period_id: m.id, seq: m.seq, member_id: m.mgr_member_id! }));
  const { roundOf } = rotation(withRecipient, active.map((m) => m.id));
  const open = months.find((m) => m.status === "open");

  // the round the group is in now: the open month's round, or the next one if nobody is chosen yet
  const earlier = withRecipient.filter((m) => !open || m.seq < open.seq);
  const before = rotation(earlier, active.map((m) => m.id));
  const round = open?.mgr_member_id ? roundOf.get(open.id)! : before.round;
  const thisRound = new Map(
    months.filter((m) => m.mgr_member_id && roundOf.get(m.id) === round).map((m) => [m.mgr_member_id!, m]),
  );
  const current = open?.mgr_member_id ? byId.get(open.mgr_member_id) : undefined;

  return (
    <div className="stack">
      <PageHeader
        title="Merry go round"
        subtitle={contribution ? <>Each member gives <strong>{formatMoney(contribution)}</strong> to the member taking it.</> : undefined}
        actions={<Link className="btn btn-secondary" href="/month">Monthly records</Link>}
      />
      {!months.length && <Alert>Start the books under <Link href="/month">Monthly records</Link> first.</Alert>}

      {open && (
        <section className="stats">
          <div className="stat stat-strong">
            <div className="stat-label">{monthLabel(open.year, open.month)}</div>
            <div className="stat-value">{current ? current.full_name : "Not chosen"}</div>
            <div className="stat-hint">Round {round}</div>
          </div>
          <Stat strong label="Collected this month" cents={open.total} hint={`From ${open.payers} member(s)`} />
          <Stat label="Expected" cents={contribution * Math.max(0, active.length - (current ? 1 : 0))} />
        </section>
      )}

      <section>
        <h2>Round {round}</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>No.</th><th>Member</th><th>Took it</th><th className="num">Received</th></tr></thead>
            <tbody>
              {active.map((m) => {
                const t = thisRound.get(m.id);
                return (
                  <tr key={m.id}>
                    <td>{m.member_no}</td>
                    <td><Link href={`/members/${m.id}`}>{m.full_name}</Link></td>
                    <td>{t ? <>{monthLabel(t.year, t.month)} {t.status === "open" && <span className="badge badge-open">open</span>}</> : <span className="muted">Not yet</span>}</td>
                    <td className="num">{t ? <Money cents={t.total} /> : "-"}</td>
                  </tr>
                );
              })}
              {!active.length && <tr><td colSpan={4} className="muted">No active members.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {withRecipient.length > 0 && (
        <section>
          <h2>History</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Month</th><th className="num">Round</th><th>Taken by</th><th className="num">Members who gave</th><th className="num">Received</th></tr></thead>
              <tbody>
                {months.filter((m) => m.mgr_member_id).map((m) => (
                  <tr key={m.id}>
                    <td><Link href={`/month?period=${m.id}`}>{monthLabel(m.year, m.month)}</Link></td>
                    <td className="num">{roundOf.get(m.id)}</td>
                    <td>{byId.get(m.mgr_member_id!)?.full_name ?? "-"}</td>
                    <td className="num">{m.payers}</td>
                    <td className="num"><Money cents={m.total} /></td>
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
