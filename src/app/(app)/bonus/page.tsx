"use client";
import { Fragment, useEffect, useState } from "react";
import { MoneyInput } from "@/components/MoneyInput";
import { Alert, Loading, Modal, Money, PageHeader, Stat } from "@/components/ui";
import { api } from "@/lib/client";
import { BONUS_CONFIRM_PHRASE } from "@/lib/ledger";
import { centsToInput, formatMoney, parseMoney } from "@/lib/money";
import { monthLabel } from "@/lib/period";
import type { Period } from "@/lib/types";

interface Allocation { member_id: string; member_no: number; full_name: string; savings: number; amount: number }
interface Preview { pool: number; total: number; method: string; allocations: Allocation[] }
interface Bonus {
  id: string; total_cents: number; method: string; payout: string; note: string | null; issued_at: string; issued_by: string;
  voided_at: string | null; voided_by: string | null; void_reason: string | null;
  period: { year: number; month: number; status: string };
  allocations: { amount_cents: number; member: { member_no: number; full_name: string } }[];
}

export default function BonusPage() {
  const [info, setInfo] = useState<{ pool: number; period: Period | null; bonuses: Bonus[] } | null>(null);
  const [role, setRole] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"savings_share" | "equal">("savings_share");
  const [payout, setPayout] = useState<"savings" | "cash">("savings");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [voiding, setVoiding] = useState<Bonus | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = () =>
    Promise.all([
      api<{ pool: number; period: Period | null; bonuses: Bonus[] }>("/api/bonus").then(setInfo),
      api<{ me: { role: string } }>("/api/settings").then((d) => setRole(d.me.role)),
    ]).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  // any change to the inputs throws the preview away, so what is issued is exactly what was seen
  useEffect(() => { setPreview(null); setConfirm(""); }, [amount, method]);

  const cents = parseMoney(amount);

  async function doPreview() {
    setError(""); setSuccess("");
    if (!cents) return setError("Enter the bonus amount.");
    setBusy(true);
    try {
      setPreview(await api<Preview>("/api/bonus/preview", { body: { total: cents, method } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function issue() {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      await api("/api/bonus", {
        body: {
          total: preview.total, method: preview.method, payout, note, confirm,
          allocations: preview.allocations.map((a) => ({ member_id: a.member_id, amount: a.amount })),
        },
      });
      setSuccess(`Bonus of ${formatMoney(preview.total)} issued to ${preview.allocations.filter((a) => a.amount > 0).length} members.`);
      setAmount(""); setNote(""); setPreview(null); setConfirm("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!info) return error ? <Alert kind="error">{error}</Alert> : <Loading />;

  return (
    <div className="stack">
      <PageHeader title="Bonus issuance" subtitle="Share out the group's interest pool to members." />
      {error && <Alert kind="error">{error}</Alert>}
      {success && <Alert kind="success">{success}</Alert>}

      <section className="stats">
        <Stat strong label="Interest pool available" cents={info.pool} hint="From months that have been rolled, less bonuses already issued" />
      </section>

      <Alert>
        <strong>Safeguards:</strong> a bonus can only come from interest of months that have been rolled (locked), never more than the
        pool. You must preview the exact share of every member and type <strong>{BONUS_CONFIRM_PHRASE}</strong> before it is issued.
        Every bonus is recorded with who issued it. Only the administrator can cancel (void) a bonus, and only before the month is rolled.
      </Alert>

      {!info.period ? (
        <Alert kind="warn">Start the books under Monthly records first.</Alert>
      ) : (
        <div className="card">
          <h2>New bonus for {monthLabel(info.period.year, info.period.month)}</h2>
          <div className="grid-form">
            <div className="field">
              <label htmlFor="amt">Total bonus amount</label>
              <MoneyInput id="amt" value={amount} onChange={setAmount} />
              <div className="hint">
                Maximum {formatMoney(info.pool)}{" "}
                {info.pool > 0 && <button type="button" className="linkish" onClick={() => setAmount(centsToInput(info.pool))}>use all</button>}
              </div>
            </div>
            <div className="field">
              <label>How to share it</label>
              <label className="check"><input type="radio" checked={method === "savings_share"} onChange={() => setMethod("savings_share")} /> In proportion to each member&apos;s savings</label>
              <label className="check"><input type="radio" checked={method === "equal"} onChange={() => setMethod("equal")} /> Equal share for every active member</label>
            </div>
            <div className="field">
              <label>How it is paid</label>
              <label className="check"><input type="radio" checked={payout === "savings"} onChange={() => setPayout("savings")} /> Credited to members&apos; savings</label>
              <label className="check"><input type="radio" checked={payout === "cash"} onChange={() => setPayout("cash")} /> Paid out in cash</label>
            </div>
          </div>
          <div className="field">
            <label htmlFor="note">Reason / note</label>
            <input id="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. End of year 2026 dividend" />
          </div>
          <button className="btn btn-secondary" disabled={busy || !cents || cents > info.pool} onClick={doPreview}>Preview shares</button>
          {cents !== null && cents > info.pool && <p className="small" style={{ color: "var(--danger)" }}>This is more than the pool available.</p>}

          {preview && (
            <div className="stack" style={{ marginTop: 16 }}>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>No.</th><th>Member</th><th className="num">Savings</th><th className="num">Bonus share</th></tr></thead>
                  <tbody>
                    {preview.allocations.map((a) => (
                      <tr key={a.member_id}>
                        <td>{a.member_no}</td><td>{a.full_name}</td>
                        <td className="num"><Money cents={a.savings} /></td>
                        <td className="num"><Money cents={a.amount} /></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><td colSpan={3}>Total (adds up exactly)</td><td className="num"><Money cents={preview.allocations.reduce((t, a) => t + a.amount, 0)} /></td></tr>
                  </tfoot>
                </table>
              </div>
              <div className="field" style={{ maxWidth: 360 }}>
                <label htmlFor="confirm">Type {BONUS_CONFIRM_PHRASE} to confirm</label>
                <input id="confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
              </div>
              <div>
                <button className="btn btn-danger" disabled={busy || confirm !== BONUS_CONFIRM_PHRASE} onClick={issue}>
                  {busy ? "Issuing..." : `Issue bonus of ${formatMoney(preview.total)} (${payout === "savings" ? "to savings" : "cash"})`}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <section>
        <h2>Bonus history</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Month</th><th className="num">Total</th><th>Shared</th><th>Paid as</th><th>Issued by</th><th>Note</th><th></th></tr></thead>
            <tbody>
              {info.bonuses.map((b) => (
                <Fragment key={b.id}>
                  <tr>
                    <td>{b.issued_at.slice(0, 10)} {b.voided_at && <span className="badge badge-error" title={b.void_reason ?? ""}>voided</span>}</td>
                    <td>{monthLabel(b.period.year, b.period.month)}</td>
                    <td className="num"><Money cents={b.total_cents} /></td>
                    <td>{b.method === "equal" ? "Equally" : "By savings"}</td>
                    <td>{b.payout === "savings" ? "To savings" : "Cash"}</td>
                    <td>{b.issued_by}</td>
                    <td>{b.note ?? ""}{b.voided_at && <div className="small muted">Voided by {b.voided_by}: {b.void_reason}</div>}</td>
                    <td className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                      <button className="btn btn-small btn-secondary" onClick={() => setExpanded(expanded === b.id ? null : b.id)}>Shares</button>
                      {role === "admin" && !b.voided_at && b.period.status === "open" && (
                        <button className="btn btn-small btn-danger" onClick={() => setVoiding(b)}>Void</button>
                      )}
                    </td>
                  </tr>
                  {expanded === b.id && (
                    <tr>
                      <td colSpan={8}>
                        {b.allocations
                          .sort((x, y) => x.member.member_no - y.member.member_no)
                          .map((a) => `${a.member.full_name}: ${formatMoney(a.amount_cents)}`)
                          .join(", ")}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {!info.bonuses.length && <tr><td colSpan={8} className="muted">No bonuses issued yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {voiding && <VoidDialog bonus={voiding} onClose={() => setVoiding(null)} onDone={() => { setVoiding(null); load(); }} />}
    </div>
  );
}

function VoidDialog({ bonus, onClose, onDone }: { bonus: Bonus; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await api(`/api/bonus/${bonus.id}/void`, { body: { reason } });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal title="Void bonus" onClose={onClose}>
      <p>This cancels the bonus of <strong>{formatMoney(bonus.total_cents)}</strong> and {bonus.payout === "savings" ? "removes it from members' savings" : "returns it to the pool (make sure the cash was returned)"}.</p>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="field"><label>Reason</label><input value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      <div className="row">
        <button className="btn btn-danger" disabled={busy || !reason.trim()} onClick={submit}>Void bonus</button>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
