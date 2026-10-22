"use client";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { MoneyInput } from "@/components/MoneyInput";
import { Alert, Loading, Money, PageHeader } from "@/components/ui";
import { api } from "@/lib/client";
import { centsToInput, parseMoney } from "@/lib/money";
import { monthLabel } from "@/lib/period";
import type { EntryRow } from "@/lib/types";

interface Member {
  id: string; member_no: number; full_name: string; phone: string | null; national_id: string | null; joined_on: string;
  registration_fee_cents: number; status: "active" | "inactive"; notes: string | null; created_at: string;
  opening_savings_cents: number; opening_loan_cents: number; opening_advance_cents: number;
}
type Detail = { member: Member; entries: HistoryRow[]; bonuses: BonusRow[]; opening_editable: boolean };
type HistoryRow = Omit<EntryRow, "member" | "is_first"> & { period: { id: string; year: number; month: number; seq: number; status: string } };
interface BonusRow { amount_cents: number; bonus: { id: string; issued_at: string; payout: string; voided_at: string | null; note: string | null } }

export default function MemberPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);

  const load = () => api<Detail>(`/api/members/${id}`).then(setData, (e) => setError(e.message));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !data) return <Alert kind="error">{error}</Alert>;
  if (!data) return <Loading />;
  const { member: m, entries, bonuses } = data;
  const latest = entries[0];
  const totals = entries.reduce(
    (t, e) => ({ paid: t.paid + e.amount_paid, saved: t.saved + e.savings_contribution, li: t.li + e.loan_issued, lr: t.lr + e.loan_repaid, ai: t.ai + e.advance_issued, ar: t.ar + e.advance_repaid }),
    { paid: 0, saved: 0, li: 0, lr: 0, ai: 0, ar: 0 },
  );

  return (
    <div className="stack">
      <PageHeader
        title={m.full_name}
        subtitle={<>Member no. {m.member_no}, joined {m.joined_on} <span className={`badge ${m.status === "active" ? "badge-open" : "badge-closed"}`}>{m.status}</span></>}
        actions={!editing && <button className="btn btn-secondary" onClick={() => setEditing(true)}>Edit details</button>}
      />
      {editing && <EditMember member={m} onDone={(saved) => { setEditing(false); if (saved) load(); }} />}
      <OpeningBalances member={m} editable={data.opening_editable} onSaved={load} />

      <section className="stats">
        <div className="stat stat-strong"><div className="stat-label">Savings</div><div className="stat-value num"><Money cents={latest?.savings_close ?? 0} /></div></div>
        <div className="stat stat-strong"><div className="stat-label">Loan balance</div><div className="stat-value num"><Money cents={latest?.loan_bal_close ?? 0} /></div></div>
        <div className="stat stat-strong"><div className="stat-label">Advance balance</div><div className="stat-value num"><Money cents={latest?.advance_bal_close ?? 0} /></div></div>
        <div className="stat"><div className="stat-label">Registration fee</div><div className="stat-value num"><Money cents={m.registration_fee_cents} /></div></div>
      </section>
      <p className="small muted">Phone: {m.phone ?? "-"} | National ID: {m.national_id ?? "-"}{m.notes ? ` | ${m.notes}` : ""}</p>

      <section>
        <h2>Member transactions</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Month</th><th className="num">Amount brought</th><th className="num">Loan repaid</th><th className="num">Advance repaid</th>
                <th className="num">Savings added</th><th className="num">Bonus</th><th className="num">Loan issued</th><th className="num">Advance issued</th>
                <th className="num">Savings c/f</th><th className="num">Loan c/f</th><th className="num">Advance c/f</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{monthLabel(e.period.year, e.period.month)} {e.period.status === "open" && <span className="badge badge-open">open</span>}</td>
                  <td className="num"><Money cents={e.amount_paid} dashZero /></td>
                  <td className="num"><Money cents={e.loan_repaid} dashZero /></td>
                  <td className="num"><Money cents={e.advance_repaid} dashZero /></td>
                  <td className="num"><Money cents={e.savings_contribution} dashZero /></td>
                  <td className="num"><Money cents={e.bonus_credit} dashZero /></td>
                  <td className="num"><Money cents={e.loan_issued} dashZero /></td>
                  <td className="num"><Money cents={e.advance_issued} dashZero /></td>
                  <td className="num"><Money cents={e.savings_close} /></td>
                  <td className="num"><Money cents={e.loan_bal_close} /></td>
                  <td className="num"><Money cents={e.advance_bal_close} /></td>
                </tr>
              ))}
              {!entries.length && <tr><td colSpan={11} className="muted">No monthly records yet.</td></tr>}
            </tbody>
            {entries.length > 0 && (
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className="num"><Money cents={totals.paid} /></td>
                  <td className="num"><Money cents={totals.lr} /></td>
                  <td className="num"><Money cents={totals.ar} /></td>
                  <td className="num"><Money cents={totals.saved} /></td>
                  <td></td>
                  <td className="num"><Money cents={totals.li} /></td>
                  <td className="num"><Money cents={totals.ai} /></td>
                  <td colSpan={3}></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>

      {bonuses.length > 0 && (
        <section>
          <h2>Bonuses received</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Paid as</th><th className="num">Amount</th><th>Note</th></tr></thead>
              <tbody>
                {bonuses.map((b) => (
                  <tr key={b.bonus.id}>
                    <td>{b.bonus.issued_at.slice(0, 10)}{b.bonus.voided_at && <> <span className="badge badge-error">voided</span></>}</td>
                    <td>{b.bonus.payout === "savings" ? "Credited to savings" : "Cash"}</td>
                    <td className="num"><Money cents={b.amount_cents} /></td>
                    <td>{b.bonus.note ?? ""}</td>
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

function EditMember({ member, onDone }: { member: Member; onDone: (saved: boolean) => void }) {
  const [f, setF] = useState({
    full_name: member.full_name, phone: member.phone ?? "", national_id: member.national_id ?? "", joined_on: member.joined_on,
    fee: centsToInput(member.registration_fee_cents), status: member.status, notes: member.notes ?? "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const fee = parseMoney(f.fee);
    if (fee === null) return setError("The registration fee is not a valid amount.");
    setBusy(true);
    try {
      await api(`/api/members/${member.id}`, {
        method: "PATCH",
        body: { full_name: f.full_name, phone: f.phone, national_id: f.national_id, joined_on: f.joined_on, registration_fee_cents: fee, status: f.status, notes: f.notes },
      });
      onDone(true);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <h2>Edit details</h2>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="grid-form">
        <div className="field"><label>Full name</label><input value={f.full_name} onChange={(e) => set("full_name")(e.target.value)} required /></div>
        <div className="field"><label>Phone</label><input value={f.phone} onChange={(e) => set("phone")(e.target.value)} /></div>
        <div className="field"><label>National ID</label><input value={f.national_id} onChange={(e) => set("national_id")(e.target.value)} /></div>
        <div className="field"><label>Date joined</label><input type="date" value={f.joined_on} onChange={(e) => set("joined_on")(e.target.value)} /></div>
        <div className="field"><label>Registration fee paid</label><MoneyInput value={f.fee} onChange={set("fee")} /></div>
        <div className="field">
          <label>Status</label>
          <select value={f.status} onChange={(e) => set("status")(e.target.value)}>
            <option value="active">Active</option>
            <option value="inactive">Inactive (left the group)</option>
          </select>
        </div>
      </div>
      <div className="field"><label>Notes</label><textarea rows={2} value={f.notes} onChange={(e) => set("notes")(e.target.value)} /></div>
      <div className="row">
        <button className="btn" disabled={busy}>{busy ? "Saving..." : "Save changes"}</button>
        <button type="button" className="btn btn-secondary" onClick={() => onDone(false)}>Cancel</button>
      </div>
    </form>
  );
}

function OpeningBalances({ member, editable, onSaved }: { member: Member; editable: boolean; onSaved: () => void }) {
  const initial = {
    savings: centsToInput(member.opening_savings_cents),
    loan: centsToInput(member.opening_loan_cents),
    advance: centsToInput(member.opening_advance_cents),
  };
  const [f, setF] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const any = member.opening_savings_cents + member.opening_loan_cents + member.opening_advance_cents > 0;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const v = { savings: parseMoney(f.savings), loan: parseMoney(f.loan), advance: parseMoney(f.advance) };
    if (Object.values(v).some((x) => x === null)) return setMsg({ kind: "error", text: "One of the amounts is not valid." });
    setBusy(true);
    try {
      await api(`/api/members/${member.id}/opening`, {
        method: "PUT",
        body: { opening_savings_cents: v.savings, opening_loan_cents: v.loan, opening_advance_cents: v.advance },
      });
      setMsg({ kind: "success", text: "Opening balances saved. Their first month has been recalculated." });
      setEditing(false);
      onSaved();
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!editable && !any) return null;
  return (
    <form className="card" onSubmit={save}>
      <div className="row">
        <h2 style={{ margin: 0 }}>Opening balances</h2>
        <span className="spacer" />
        {editable && !editing && <button type="button" className="btn btn-secondary btn-small" onClick={() => { setF(initial); setEditing(true); }}>Change</button>}
      </div>
      <p className="small muted" style={{ marginTop: 6 }}>
        {editable
          ? "What this member already had when they were brought into the system. These are the balances b/f of their first month, and can be changed until that month is rolled."
          : "What this member already had when they were brought into the system. Their first month has been rolled, so these are locked."}
      </p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {editing ? (
        <>
          <div className="grid-form">
            <div className="field"><label>Savings already held</label><MoneyInput value={f.savings} onChange={(x) => setF({ ...f, savings: x })} /></div>
            <div className="field"><label>Loan balance still owed</label><MoneyInput value={f.loan} onChange={(x) => setF({ ...f, loan: x })} /></div>
            <div className="field"><label>Advance balance still owed</label><MoneyInput value={f.advance} onChange={(x) => setF({ ...f, advance: x })} /></div>
          </div>
          <div className="row">
            <button className="btn" disabled={busy}>{busy ? "Saving..." : "Save opening balances"}</button>
            <button type="button" className="btn btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </>
      ) : (
        <p>
          Savings <Money cents={member.opening_savings_cents} /> | Loan <Money cents={member.opening_loan_cents} /> | Advance{" "}
          <Money cents={member.opening_advance_cents} />
        </p>
      )}
    </form>
  );
}
