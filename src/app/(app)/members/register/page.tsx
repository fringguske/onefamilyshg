"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { MoneyInput } from "@/components/MoneyInput";
import { Alert, PageHeader } from "@/components/ui";
import { api, useDraft, useUnsavedWarning } from "@/lib/client";
import { centsToInput, formatMoney, parseMoney } from "@/lib/money";
import type { Settings } from "@/lib/types";

const today = () => new Date().toISOString().slice(0, 10);
const EMPTY = { full_name: "", phone: "", national_id: "", joined_on: "", fee: "", notes: "" };

export default function RegisterPage() {
  // the form is kept in the browser, so nothing is lost if you leave the page halfway
  const [form, setForm, clearForm] = useDraft("mgr:draft:register", EMPTY);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ id: string; member_no: number; full_name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = Object.values(form).some((v) => v !== "");
  useUnsavedWarning(dirty);

  useEffect(() => {
    api<{ settings: Settings }>("/api/settings").then((d) => setSettings(d.settings), (e) => setError(e.message));
  }, []);

  const set = (k: keyof typeof EMPTY) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const feeText = form.fee === "" && settings ? centsToInput(settings.registration_fee_cents) : form.fee;
  const fee = parseMoney(feeText);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (fee === null) return setError("The registration fee is not a valid amount.");
    setBusy(true);
    setError("");
    try {
      const { member } = await api<{ member: { id: string; member_no: number; full_name: string } }>("/api/members", {
        body: {
          full_name: form.full_name, phone: form.phone, national_id: form.national_id, notes: form.notes,
          joined_on: form.joined_on || today(), registration_fee_cents: fee,
        },
      });
      clearForm();
      setDone(member);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <PageHeader title="Registration" subtitle="Add a new member to the group." />
      {done && (
        <Alert kind="success">
          <strong>{done.full_name}</strong> is registered as member no. {done.member_no}.{" "}
          <Link href={`/members/${done.id}`}>Open their record</Link> | <Link href="/month">Go to monthly records</Link>
        </Alert>
      )}
      {error && <Alert kind="error">{error}</Alert>}
      <form className="card" onSubmit={submit}>
        {dirty && <p className="small muted">Draft saved on this device. It will still be here if you leave and come back.</p>}
        <div className="grid-form">
          <div className="field">
            <label htmlFor="name">Full name *</label>
            <input id="name" value={form.full_name} onChange={(e) => set("full_name")(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="phone">Phone</label>
            <input id="phone" inputMode="tel" value={form.phone} onChange={(e) => set("phone")(e.target.value)} placeholder="07XX XXX XXX" />
          </div>
          <div className="field">
            <label htmlFor="nid">National ID</label>
            <input id="nid" value={form.national_id} onChange={(e) => set("national_id")(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="joined">Date joined</label>
            <input id="joined" type="date" value={form.joined_on || today()} onChange={(e) => set("joined_on")(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="fee">Registration fee paid ({settings?.currency ?? "KES"})</label>
            <MoneyInput id="fee" value={feeText} onChange={set("fee")} />
            <div className="hint">Standard fee: {settings ? formatMoney(settings.registration_fee_cents) : "..."}</div>
          </div>
        </div>
        <div className="field">
          <label htmlFor="notes">Notes</label>
          <textarea id="notes" rows={2} value={form.notes} onChange={(e) => set("notes")(e.target.value)} />
        </div>
        <p className="small muted">
          Moving an existing member into the system? Register them here, then type their savings, loan and advance
          balances b/f in their first month under Monthly records.
        </p>
        <div className="row">
          <button className="btn" disabled={busy || !form.full_name.trim()}>{busy ? "Saving..." : "Register member"}</button>
          {dirty && <button type="button" className="btn btn-secondary" onClick={clearForm}>Clear form</button>}
        </div>
      </form>
    </div>
  );
}
