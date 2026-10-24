"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Alert, Loading, Money, PageHeader, Stat } from "@/components/ui";
import { api } from "@/lib/client";
import { rotation } from "@/lib/mgr";
import { monthLabel } from "@/lib/period";

interface Month {
  id: string; year: number; month: number; seq: number; status: string; mgr_member_id: string | null; total: number; payers: number;
}
interface Member { id: string; member_no: number; full_name: string; status: string }
interface Data { months: Month[]; members: Member[]; contribution: number }

export default function MgrPage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api<Data>("/api/mgr").then(setData, (e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  if (error && !data) return <Alert kind="error">{error}</Alert>;
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
  const tookLabel = (memberId: string) => {
    const t = before.taken.get(memberId);
    const m = t && months.find((x) => x.id === t.period_id);
    return m ? ` (took it ${monthLabel(m.year, m.month)})` : "";
  };

  async function give(memberId: string) {
    setBusy(true);
    setError("");
    try {
      await api("/api/mgr", { method: "PUT", body: { period_id: open!.id, member_id: memberId || null } });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <PageHeader
        title="Merry go round"
        actions={<Link className="btn btn-secondary" href="/month">Monthly records</Link>}
      />
      {!months.length && <Alert>Start the books under <Link href="/month">Monthly records</Link> first.</Alert>}
      {error && <Alert kind="error">{error}</Alert>}

      {open && (
        <>
          <section className="stats">
            <div className="stat stat-strong">
              <div className="stat-label">{monthLabel(open.year, open.month)}</div>
              <div className="stat-value">{current ? current.full_name : "Not chosen"}</div>
              <div className="stat-hint">Round {round}</div>
            </div>
            <Stat strong label="Collected this month" cents={open.total} hint={`From ${open.payers} member(s), fed under Monthly records`} />
            <Stat label="Expected" cents={contribution * active.length} hint={`${active.length} active member(s)`} />
          </section>
          <div className="card">
            <div className="row">
              <label htmlFor="mgr-recipient"><strong>Give the {monthLabel(open.year, open.month)} merry go round to</strong></label>
              <select id="mgr-recipient" value={open.mgr_member_id ?? ""} disabled={busy} onChange={(e) => give(e.target.value)}>
                <option value="">Choose who takes it</option>
                {active.map((m) => (
                  <option key={m.id} value={m.id}>{m.member_no}. {m.full_name}{tookLabel(m.id)}</option>
                ))}
              </select>
              <span className="spacer" />
              {current && <span>{current.full_name} is given <strong><Money cents={open.total} /></strong></span>}
            </div>
          </div>
        </>
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
