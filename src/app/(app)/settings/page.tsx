"use client";
import { useEffect, useState } from "react";
import { MoneyInput } from "@/components/MoneyInput";
import { Alert, Loading, PageHeader } from "@/components/ui";
import { api } from "@/lib/client";
import { centsToInput, formatMoney, formatPercent, parseMoney, parsePercent } from "@/lib/money";
import type { Settings } from "@/lib/types";

interface Me { name: string; role: "admin" | "chairman"; username: string }

export default function SettingsPage() {
  const [data, setData] = useState<{ settings: Settings; me: Me } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ settings: Settings; me: Me }>("/api/settings").then(setData, (e) => setError(e.message));
  }, []);
  if (error) return <Alert kind="error">{error}</Alert>;
  if (!data) return <Loading />;
  const admin = data.me.role === "admin";

  return (
    <div className="stack">
      <PageHeader title="Settings" subtitle={`Signed in as ${data.me.name} (${admin ? "administrator" : "chairman"}).`} />
      <GroupSettings settings={data.settings} canEdit={admin} onSaved={(settings) => setData({ ...data, settings })} />
      {!admin && <ChangePassword />}
      {admin && <Chairmen />}
      {admin && <UndoRoll />}
      {admin && <AuditLog />}
    </div>
  );
}

function GroupSettings({ settings, canEdit, onSaved }: { settings: Settings; canEdit: boolean; onSaved: (s: Settings) => void }) {
  const [f, setF] = useState({
    group_name: settings.group_name,
    currency: settings.currency,
    loan_rate: formatPercent(settings.loan_rate_bps),
    advance_rate: formatPercent(settings.advance_rate_bps),
    fee: centsToInput(settings.registration_fee_cents),
    opening_cash: centsToInput(settings.opening_cash_cents),
    opening_interest: centsToInput(settings.opening_interest_pool_cents),
  });
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const body = {
      group_name: f.group_name, currency: f.currency,
      loan_rate_bps: parsePercent(f.loan_rate), advance_rate_bps: parsePercent(f.advance_rate),
      registration_fee_cents: parseMoney(f.fee), opening_cash_cents: parseMoney(f.opening_cash),
      opening_interest_pool_cents: parseMoney(f.opening_interest),
    };
    if (Object.values(body).some((v) => v === null)) return setMsg({ kind: "error", text: "Check the numbers. One of them is not valid." });
    setBusy(true);
    try {
      const { settings: s } = await api<{ settings: Settings }>("/api/settings", { method: "PUT", body });
      onSaved(s);
      setMsg({ kind: "success", text: "Settings saved. New interest rates apply from the next roll." });
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <h2>Group settings</h2>
      {!canEdit && <p className="muted small">Only the administrator can change these.</p>}
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="grid-form">
          <div className="field"><label>Group name</label><input value={f.group_name} onChange={(e) => set("group_name")(e.target.value)} /></div>
          <div className="field"><label>Currency</label><input value={f.currency} onChange={(e) => set("currency")(e.target.value)} /></div>
          <div className="field">
            <label>Loan interest (% per month)</label>
            <input inputMode="decimal" value={f.loan_rate} onChange={(e) => set("loan_rate")(e.target.value)} className={parsePercent(f.loan_rate) === null ? "invalid" : ""} />
          </div>
          <div className="field">
            <label>Advance interest (% per month)</label>
            <input inputMode="decimal" value={f.advance_rate} onChange={(e) => set("advance_rate")(e.target.value)} className={parsePercent(f.advance_rate) === null ? "invalid" : ""} />
          </div>
          <div className="field"><label>Standard registration fee</label><MoneyInput value={f.fee} onChange={set("fee")} /></div>
          <div className="field">
            <label>Opening cash</label><MoneyInput value={f.opening_cash} onChange={set("opening_cash")} />
            <div className="hint">Cash/bank the group held when the books were started here.</div>
          </div>
          <div className="field">
            <label>Interest pool brought in</label><MoneyInput value={f.opening_interest} onChange={set("opening_interest")} />
            <div className="hint">Interest earned before this system and not yet shared out.</div>
          </div>
        </div>
        {canEdit && <button className="btn" disabled={busy}>{busy ? "Saving..." : "Save settings"}</button>}
      </fieldset>
    </form>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api("/api/auth/password", { body: { current, next } });
      setMsg({ kind: "success", text: "Password changed." });
      setCurrent(""); setNext("");
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    }
  }
  return (
    <form className="card" onSubmit={save}>
      <h2>Change my password</h2>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="grid-form">
        <div className="field"><label>Current password</label><input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></div>
        <div className="field"><label>New password (8+ characters)</label><input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></div>
      </div>
      <button className="btn" disabled={!current || next.length < 8}>Change password</button>
    </form>
  );
}

interface User { id: string; username: string; display_name: string; active: boolean; created_at: string }

function Chairmen() {
  const [users, setUsers] = useState<User[] | null>(null);
  const [f, setF] = useState({ username: "", display_name: "", password: "" });
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const load = () => api<{ users: User[] }>("/api/users").then((d) => setUsers(d.users), (e) => setMsg({ kind: "error", text: e.message }));
  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api("/api/users", { body: f });
      setMsg({ kind: "success", text: `Account "${f.username}" created. Give the chairman their username and password.` });
      setF({ username: "", display_name: "", password: "" });
      load();
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    }
  }

  async function update(u: User, body: Record<string, unknown>, done: string) {
    try {
      await api(`/api/users/${u.id}`, { method: "PATCH", body });
      setMsg({ kind: "success", text: done });
      load();
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    }
  }

  function resetPassword(u: User) {
    const pw = window.prompt(`New password for ${u.display_name} (at least 8 characters):`);
    if (pw) update(u, { password: pw }, `Password for ${u.username} was reset.`);
  }

  return (
    <div className="card">
      <h2>Chairman accounts</h2>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {!users ? <Loading /> : (
        <div className="table-wrap" style={{ marginBottom: 16 }}>
          <table>
            <thead><tr><th>Name</th><th>Username</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.display_name}</td><td>{u.username}</td>
                  <td><span className={`badge ${u.active ? "badge-open" : "badge-closed"}`}>{u.active ? "active" : "disabled"}</span></td>
                  <td className="row" style={{ gap: 6 }}>
                    <button className="btn btn-small btn-secondary" onClick={() => resetPassword(u)}>Reset password</button>
                    <button className="btn btn-small btn-secondary" onClick={() => update(u, { active: !u.active }, `${u.username} ${u.active ? "disabled" : "enabled"}.`)}>
                      {u.active ? "Disable" : "Enable"}
                    </button>
                  </td>
                </tr>
              ))}
              {!users.length && <tr><td colSpan={4} className="muted">No chairman account yet. Create one below.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <form onSubmit={create}>
        <h3>Create chairman account</h3>
        <div className="grid-form">
          <div className="field"><label>Name</label><input value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></div>
          <div className="field"><label>Username</label><input autoCapitalize="none" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></div>
          <div className="field"><label>Password (8+ characters)</label><input type="text" autoComplete="off" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
        </div>
        <button className="btn" disabled={!f.username || !f.display_name || f.password.length < 8}>Create account</button>
      </form>
    </div>
  );
}

function UndoRoll() {
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function undo() {
    if (!window.confirm("Reopen the previous month? This only works if nothing has been fed in the current month yet.")) return;
    setBusy(true);
    try {
      await api("/api/roll/undo", { method: "POST" });
      setMsg({ kind: "success", text: "The previous month is open again. Correct it, then roll again." });
    } catch (err) {
      setMsg({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card">
      <h2>Undo the last roll</h2>
      <p className="muted">If the month was rolled by mistake or a record must be corrected, you can reopen it, as long as nothing has been fed in the new month yet.</p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <button className="btn btn-danger" disabled={busy} onClick={undo}>Undo last roll</button>
    </div>
  );
}

interface LogRow { id: number; at: string; actor: string; action: string; details: Record<string, unknown> | null }

function AuditLog() {
  const [log, setLog] = useState<LogRow[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open && !log) api<{ log: LogRow[] }>("/api/audit").then((d) => setLog(d.log), () => setLog([]));
  }, [open, log]);
  return (
    <div className="card">
      <div className="row">
        <h2 style={{ margin: 0 }}>Audit trail</h2>
        <span className="spacer" />
        <button className="btn btn-secondary btn-small" onClick={() => setOpen(!open)}>{open ? "Hide" : "Show last 300 actions"}</button>
      </div>
      {open && (!log ? <Loading /> : (
        <div className="table-wrap" style={{ marginTop: 12, maxHeight: 480, overflowY: "auto" }}>
          <table>
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
            <tbody>
              {log.map((r) => (
                <tr key={r.id}>
                  <td className="num">{new Date(r.at).toLocaleString()}</td>
                  <td>{r.actor}</td>
                  <td>{r.action.replace(/_/g, " ")}</td>
                  <td className="small"><code>{describe(r.details)}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function describe(d: Record<string, unknown> | null): string {
  if (!d) return "";
  const s = JSON.stringify(d, (k, v) => (typeof v === "number" && /cents|amount|paid|repaid|issued|open|total/.test(k) ? formatMoney(v) : v));
  return s.length > 220 ? s.slice(0, 220) + "..." : s;
}
