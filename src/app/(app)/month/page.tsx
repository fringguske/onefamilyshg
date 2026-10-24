"use client";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BankingDialog } from "@/components/BankingDialog";
import { MoneyInput } from "@/components/MoneyInput";
import { Alert, Loading, Modal, Money, PageHeader } from "@/components/ui";
import { api, readStore, track, useUnsavedWarning, writeStore } from "@/lib/client";
import { autoSplit, computeEntry, expectedAmount, interestDue, MANUAL_FIELDS, type Computed, type ManualInputs, type Openings, type Terms } from "@/lib/ledger";
import { centsToInput, formatMoney, formatPercent, parseMoney } from "@/lib/money";
import { MONTH_NAMES, monthLabel, nextMonth } from "@/lib/period";
import type { EntryRow, Period } from "@/lib/types";

type ManualKey = (typeof MANUAL_FIELDS)[number];

/** Unsaved typing for one member, kept in the browser until it is saved. */
interface Draft {
  base: number; // the record version the draft was started from
  f: Record<ManualKey, string>;
}
type Drafts = Record<string, Draft>;

interface MonthData {
  period: Period | null;
  rows: EntryRow[];
  rates?: { advance_rate_bps: number };
  mgr_contribution_cents?: number;
  currency?: string;
}

const draftKey = (periodId: string) => `mgr:draft:month:${periodId}`;

export default function MonthPageWrapper() {
  return (
    <Suspense fallback={<Loading />}>
      <MonthPage />
    </Suspense>
  );
}

function MonthPage() {
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get("period");

  const [periods, setPeriods] = useState<Period[] | null>(null);
  const [data, setData] = useState<MonthData | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [justSaved, setJustSaved] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [rollOpen, setRollOpen] = useState(false);
  const [bankingOpen, setBankingOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const period = data?.period ?? null;
  const editable = period?.status === "open";

  const load = useCallback(async (periodId: string | null) => {
    setLoading(true);
    setError("");
    try {
      const [p, d] = await Promise.all([
        api<{ periods: Period[] }>("/api/periods"),
        api<MonthData>(`/api/month${periodId ? `?period=${periodId}` : ""}`),
      ]);
      setPeriods(p.periods);
      setData(d);
      setRowErrors({});
      setJustSaved({});
      // bring back anything typed earlier on this device that was not saved yet
      if (d.period?.status === "open") {
        const stored = readStore<Drafts>(draftKey(d.period.id), {});
        const ids = new Set(d.rows.map((r) => r.id));
        // drafts typed before a field was added or removed are dropped
        const usable = ([id, d]: [string, Draft]) => ids.has(id) && MANUAL_FIELDS.every((k) => typeof d.f?.[k] === "string");
        setDrafts(Object.fromEntries(Object.entries(stored).filter(usable)));
      } else {
        setDrafts({});
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(requested);
  }, [requested, load]);

  // every keystroke is written to browser storage immediately
  useEffect(() => {
    if (period?.status === "open") {
      writeStore(draftKey(period.id), Object.keys(drafts).length ? drafts : null);
    }
  }, [drafts, period]);

  const dirtyIds = Object.keys(drafts);
  useUnsavedWarning(dirtyIds.length > 0);

  /** The rate and merry go round amount every member's record is worked out with. */
  const terms = useCallback(
    (): Terms => ({
      advance_rate_bps: data?.rates?.advance_rate_bps ?? 0,
      mgr_due: data?.mgr_contribution_cents ?? 0,
    }),
    [data],
  );

  /** Combines the stored record with any draft into what the row shows now. */
  const view = useCallback(
    (row: EntryRow) => {
      const d = drafts[row.id];
      const text = {} as Record<ManualKey, string>;
      const inputs = {} as ManualInputs;
      let invalid = false;
      for (const k of MANUAL_FIELDS) {
        text[k] = d ? d.f[k] : centsToInput(row[k]);
        const c = parseMoney(text[k]);
        if (c === null) invalid = true;
        inputs[k] = c ?? 0;
      }
      const openings: Openings = {
        savings_open: row.savings_open, advance_bal_open: row.advance_bal_open,
        advance_interest_bf: row.advance_interest_bf, advance_interest_charged: row.advance_interest_charged,
        bonus_credit: row.bonus_credit,
      };
      const t = terms();
      const result = computeEntry(openings, inputs, t);
      const errors = result.errors;
      // saved figures are shown as saved; only typing is worked out again
      const computed: Computed = d ? result.computed : row;
      if (invalid) errors.unshift("One of the amounts is not a valid number (use digits, up to 2 decimals).");
      const expected = expectedAmount(openings, t.mgr_due);
      return { text, inputs, openings, computed, errors, expected, draft: d, conflict: !!d && d.base !== row.version };
    },
    [drafts, terms],
  );

  function edit(row: EntryRow, field: ManualKey, value: string) {
    setJustSaved((s) => ({ ...s, [row.id]: false }));
    setDrafts((all) => {
      const cur: Draft = all[row.id] ?? {
        base: row.version,
        f: Object.fromEntries(MANUAL_FIELDS.map((k) => [k, centsToInput(row[k])])) as Record<ManualKey, string>,
      };
      const next: Draft = { ...cur, f: { ...cur.f } };
      next.f[field] = value;
      // a new amount brought fills the advance repayment and merry go round again;
      // the chairman can still change them afterwards
      const paid = parseMoney(value);
      if (field === "amount_paid" && paid !== null) {
        const split = autoSplit(row, paid, terms().mgr_due);
        next.f.advance_repaid = centsToInput(split.advance_repaid);
        next.f.mgr_contribution = centsToInput(split.mgr_contribution);
      }
      // a draft that matches the saved record is not a draft any more
      const same = MANUAL_FIELDS.every((k) => parseMoney(next.f[k]) === row[k]);
      const copy = { ...all };
      if (same && next.base === row.version) delete copy[row.id];
      else copy[row.id] = next;
      return copy;
    });
  }

  function discard(id: string) {
    setDrafts((all) => {
      const copy = { ...all };
      delete copy[id];
      return copy;
    });
    setRowErrors((e) => ({ ...e, [id]: "" }));
  }

  function keepDraft(row: EntryRow) {
    setDrafts((all) => ({ ...all, [row.id]: { ...all[row.id], base: row.version } }));
  }

  async function saveRow(row: EntryRow): Promise<boolean> {
    const v = view(row);
    if (!v.draft || v.errors.length || v.conflict) return false;
    setSaving((s) => ({ ...s, [row.id]: true }));
    setRowErrors((e) => ({ ...e, [row.id]: "" }));
    try {
      const body = {
        version: v.draft.base,
        inputs: v.inputs,
        notes: row.notes,
      };
      const { row: saved } = await api<{ row: EntryRow }>(`/api/entries/${row.id}`, { method: "PUT", body });
      setData((d) => d && { ...d, rows: d.rows.map((r) => (r.id === row.id ? { ...saved, is_first: r.is_first } : r)) });
      discard(row.id);
      setJustSaved((s) => ({ ...s, [row.id]: true }));
      return true;
    } catch (e) {
      setRowErrors((x) => ({ ...x, [row.id]: (e as Error).message }));
      return false;
    } finally {
      setSaving((s) => ({ ...s, [row.id]: false }));
    }
  }

  async function saveAll() {
    setNotice("");
    let ok = 0, failed = 0;
    for (const row of data?.rows ?? []) {
      if (!drafts[row.id]) continue;
      if (await saveRow(row)) ok++;
      else failed++;
    }
    setNotice(failed ? `${ok} saved, ${failed} not saved. Check the rows marked in red.` : `${ok} record(s) saved.`);
  }

  const rows = data?.rows ?? [];
  const shown = useMemo(() => {
    const n = filter.trim().toLowerCase();
    return n ? rows.filter((r) => r.member.full_name.toLowerCase().includes(n) || String(r.member.member_no) === n) : rows;
  }, [rows, filter]);

  const totals = useMemo(() => {
    const t = { sb: 0, ab: 0, due: 0, exp: 0, paid: 0, ar: 0, mgr: 0, sav: 0, ai: 0, sc: 0, ac: 0 };
    for (const r of rows) {
      const v = view(r);
      t.sb += v.openings.savings_open; t.ab += v.openings.advance_bal_open;
      t.due += interestDue(v.openings); t.exp += v.expected; t.paid += v.inputs.amount_paid; t.ar += v.inputs.advance_repaid;
      t.mgr += v.inputs.mgr_contribution; t.sav += v.computed.savings_contribution;
      t.ai += v.inputs.advance_issued; t.sc += v.computed.savings_close; t.ac += v.computed.advance_bal_close;
    }
    return t;
  }, [rows, view]);

  if (error && !data) return <Alert kind="error">{error}</Alert>;
  if (!data || !periods) return <Loading />;

  if (!period) {
    return <StartBooks onStarted={() => load(null)} />;
  }

  const label = monthLabel(period.year, period.month);
  const nm = nextMonth(period.year, period.month);
  const openPeriod = periods.find((p) => p.status === "open");

  async function saveCost(cents: number) {
    await api("/api/periods", { method: "PUT", body: { period_id: period!.id, transaction_cost: cents } });
    setData((d) => (d?.period ? { ...d, period: { ...d.period, transaction_cost: cents } } : d));
    setPeriods((ps) => ps && ps.map((p) => (p.id === period!.id ? { ...p, transaction_cost: cents } : p)));
  }

  return (
    <div className="stack">
      <PageHeader
        title={`Monthly records: ${label}`}
        subtitle={
          editable ? (
            <span className="badge badge-open">Open</span>
          ) : (
            <>This month has been rolled and is locked. <span className="badge badge-closed">Rolled {period.closed_at?.slice(0, 10)}</span></>
          )
        }
        actions={
          <>
            <select aria-label="Choose month" value={period.id} onChange={(e) => router.push(`/month?period=${e.target.value}`)}>
              {periods.map((p) => (
                <option key={p.id} value={p.id}>{monthLabel(p.year, p.month)}{p.status === "open" ? " (open)" : ""}</option>
              ))}
            </select>
            <button className="btn btn-secondary" disabled={loading} onClick={() => { if (requested) router.push("/month"); else { track("records_loaded"); load(null); } }}>
              {loading ? "Loading..." : "Load group records for this month"}
            </button>
            <button className="btn btn-secondary" onClick={() => { track("csv_exported"); exportCsv(label, rows, view); }}>Export CSV</button>
            <button className="btn" onClick={() => setBankingOpen(true)}>View this month banking</button>
          </>
        }
      />

      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind={notice.includes("not saved") ? "warn" : "success"}>{notice}</Alert>}
      {!editable && openPeriod && (
        <Alert>You are viewing a past month. <a href="/month">Go to the open month ({monthLabel(openPeriod.year, openPeriod.month)})</a>.</Alert>
      )}
      {editable && dirtyIds.length > 0 && (
        <Alert kind="warn">
          <div className="row">
            <span><strong>{dirtyIds.length}</strong> record(s) typed but not saved yet. They are kept on this device, so you can leave and come back.</span>
            <span className="spacer" />
            <button className="btn btn-small" onClick={saveAll}>Save all</button>
          </div>
        </Alert>
      )}

      <div className="row no-print">
        <input className="table-search" placeholder="Find member" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="spacer" />
        {editable && (
          <>
            <button className="btn" disabled={!dirtyIds.length} onClick={saveAll}>Save all changes</button>
            <button className="btn btn-secondary" onClick={() => setRollOpen(true)}>Roll to {monthLabel(nm.year, nm.month)}</button>
          </>
        )}
      </div>

      <TransactionCost key={period.id} saved={period.transaction_cost} editable={editable} onSave={saveCost} />

      <div className="table-wrap sheet">
        <table>
          <thead>
            <tr>
              <th rowSpan={2}>Member</th>
              <th className="group" colSpan={2}>Brought forward (auto)</th>
              <th className="group" colSpan={2}>Due (auto)</th>
              <th className="group" colSpan={3}>Fed this month</th>
              <th className="group" colSpan={1}>Auto</th>
              <th className="group" colSpan={1}>Issued this month</th>
              <th className="group" colSpan={2}>Carried forward (auto)</th>
              {editable && <th rowSpan={2}></th>}
            </tr>
            <tr>
              <th className="num">Savings</th><th className="num">Advance</th>
              <th className="num">Interest due</th><th className="num">Expected</th><th className="num">Amount brought</th><th className="num">Advance repaid</th><th className="num">Merry go round</th>
              <th className="num">Savings added</th>
              <th className="num">New advance</th>
              <th className="num">Savings</th><th className="num">Advance</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => {
              const v = view(row);
              const due = interestDue(v.openings);
              const err = rowErrors[row.id] || (v.draft ? v.errors.join(" ") : "");
              const money = (k: ManualKey, lbl: string) => (
                <td className="num" data-label={lbl}>
                  {editable ? (
                    <MoneyInput label={`${lbl}, ${row.member.full_name}`} value={v.text[k]} onChange={(x) => edit(row, k, x)} />
                  ) : (
                    <Money cents={row[k]} dashZero />
                  )}
                </td>
              );
              const bf = (k: "savings_open" | "advance_bal_open", lbl: string) => (
                <td className="num auto" data-label={lbl}>
                  <Money cents={v.openings[k]} />
                </td>
              );
              return (
                <tr
                  key={row.id}
                  className={err ? "row-error" : v.draft ? "row-dirty" : undefined}
                  onKeyDown={(e) => { if (e.key === "Enter" && editable) saveRow(row); }}
                >
                  <td className="member-cell">
                    <div><strong>{row.member.full_name}</strong></div>
                    <div className="no">
                      No. {row.member.member_no}
                      {row.member.status !== "active" && ", inactive"}
                    </div>
                    {err && <div className="row-errors">{err}</div>}
                    {v.conflict && (
                      <div className="row-errors">
                        This record was changed by someone else after you started typing.{" "}
                        <button className="linkish" onClick={() => keepDraft(row)}>Keep my figures</button> or{" "}
                        <button className="linkish" onClick={() => discard(row.id)}>Use saved figures</button>
                      </div>
                    )}
                  </td>
                  {bf("savings_open", "Savings b/f")}
                  {bf("advance_bal_open", "Advance b/f")}
                  <td className="num auto" data-label="Interest due"><Money cents={due} dashZero /></td>
                  <td className="num auto" data-label="Expected"><Money cents={v.expected} dashZero /></td>
                  {money("amount_paid", "Amount brought")}
                  {money("advance_repaid", "Advance repaid")}
                  {money("mgr_contribution", "Merry go round")}
                  <td className="num auto" data-label="Savings added"><Money cents={v.computed.savings_contribution} dashZero /></td>
                  <td className="num" data-label="New advance">
                    {editable ? (
                      <MoneyInput label={`New advance, ${row.member.full_name}`} value={v.text.advance_issued} onChange={(x) => edit(row, "advance_issued", x)} />
                    ) : (
                      <Money cents={row.advance_issued} dashZero />
                    )}
                    <AdvanceCut issued={v.inputs.advance_issued} cut={v.computed.advance_interest_deducted} />
                  </td>
                  <td className="num auto" data-label="Savings c/f"><Money cents={v.computed.savings_close} /></td>
                  <td className="num auto" data-label="Advance c/f"><Money cents={v.computed.advance_bal_close} /></td>
                  {editable && (
                    <td data-label="">
                      {v.draft ? (
                        <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                          <button className="btn btn-small" disabled={saving[row.id] || v.errors.length > 0 || v.conflict} onClick={() => saveRow(row)}>
                            {saving[row.id] ? "Saving" : "Save"}
                          </button>
                          <button className="btn btn-small btn-secondary" onClick={() => discard(row.id)} title="Undo my typing">Undo</button>
                        </div>
                      ) : justSaved[row.id] ? (
                        <span className="badge badge-saved">Saved</span>
                      ) : null}
                    </td>
                  )}
                </tr>
              );
            })}
            {!shown.length && <tr><td colSpan={13} className="muted">No members in this month. Register members first.</td></tr>}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr>
                <td>Totals ({rows.length})</td>
                <td className="num"><Money cents={totals.sb} /></td>
                <td className="num"><Money cents={totals.ab} /></td>
                <td className="num"><Money cents={totals.due} /></td>
                <td className="num"><Money cents={totals.exp} /></td>
                <td className="num"><Money cents={totals.paid} /></td>
                <td className="num"><Money cents={totals.ar} /></td>
                <td className="num"><Money cents={totals.mgr} /></td>
                <td className="num"><Money cents={totals.sav} /></td>
                <td className="num"><Money cents={totals.ai} /></td>
                <td className="num"><Money cents={totals.sc} /></td>
                <td className="num"><Money cents={totals.ac} /></td>
                {editable && <td></td>}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {bankingOpen && <BankingDialog period={period} unsaved={editable ? dirtyIds.length : 0} onClose={() => setBankingOpen(false)} />}

      {rollOpen && editable && (
        <RollDialog
          period={period}
          rows={rows}
          rate={data.rates?.advance_rate_bps ?? 0}
          unsaved={dirtyIds.length}
          onClose={() => setRollOpen(false)}
          onRolled={() => {
            writeStore(draftKey(period.id), null);
            setDrafts({});
            setRollOpen(false);
            setNotice(`${label} has been rolled. ${monthLabel(nm.year, nm.month)} is ready to be fed.`);
            if (requested) router.push("/month");
            else load(null);
          }}
        />
      )}
    </div>
  );
}

function RollDialog({ period, rows, rate, unsaved, onClose, onRolled }: {
  period: Period; rows: EntryRow[]; rate: number; unsaved: number; onClose: () => void; onRolled: () => void;
}) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const label = monthLabel(period.year, period.month);
  const nm = nextMonth(period.year, period.month);
  const nothingBrought = rows.filter((r) => r.member.status === "active" && r.amount_paid === 0).length;

  async function roll() {
    setBusy(true);
    setError("");
    try {
      await api("/api/roll", { body: { period_id: period.id } });
      onRolled();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`Roll ${label} to ${monthLabel(nm.year, nm.month)}`} onClose={onClose}>
      <p>Rolling will:</p>
      <ul>
        <li><strong>Lock {label}</strong>. Its records can no longer be changed.</li>
        <li>Carry every member&apos;s savings and advance balance into {monthLabel(nm.year, nm.month)}.</li>
        <li>Charge {formatPercent(rate)}% interest on any advance that was due in {label} and is still unpaid.</li>
        <li>Leave the amounts to be fed for {monthLabel(nm.year, nm.month)} empty.</li>
      </ul>
      {error && <Alert kind="error">{error}</Alert>}
      {unsaved > 0 ? (
        <Alert kind="error">{unsaved} record(s) are typed but not saved. Save or undo them before rolling.</Alert>
      ) : (
        <>
          {!period.mgr_member_id && (
            <Alert kind="warn">Nobody has been given the merry go round for {label}. Choose who takes it under <a href="/mgr">Merry go round</a>.</Alert>
          )}
          {nothingBrought > 0 && (
            <Alert kind="warn">{nothingBrought} active member(s) have no amount recorded for {label}. Their unpaid interest will be carried forward.</Alert>
          )}
          <label className="check">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            I have checked the records for {label}.
          </label>
        </>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" disabled={busy || unsaved > 0 || !checked} onClick={roll}>{busy ? "Rolling..." : `Roll to ${monthLabel(nm.year, nm.month)}`}</button>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

/** One amount for the whole month, paid by the group out of the interest pool. */
function TransactionCost({ saved, editable, onSave }: { saved: number; editable: boolean; onSave: (cents: number) => Promise<void> }) {
  const [text, setText] = useState(centsToInput(saved));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const cents = parseMoney(text);
  const changed = cents !== saved;

  async function save() {
    if (cents === null) return;
    setBusy(true);
    setMsg(null);
    try {
      await onSave(cents);
      setMsg({ kind: "success", text: "Saved" });
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="row cost-field">
      <label htmlFor="transaction-cost"><strong>Transaction cost</strong></label>
      {editable ? (
        <>
          <MoneyInput id="transaction-cost" value={text} onChange={(v) => { setText(v); setMsg(null); }} />
          <button className="btn btn-small no-print" disabled={busy || !changed || cents === null} onClick={save}>{busy ? "Saving" : "Save"}</button>
          {msg && !changed && msg.kind === "success" && <span className="badge badge-saved">Saved</span>}
          {msg?.kind === "error" && <span className="row-errors">{msg.text}</span>}
        </>
      ) : (
        <Money cents={saved} />
      )}
      <span className="small muted">Taken from the interest pool</span>
    </div>
  );
}

/** Under a new advance: the interest cut from it and the cash the member is handed. */
function AdvanceCut({ issued, cut }: { issued: number; cut: number }) {
  if (!issued || !cut) return null;
  return <div className="cell-hint">Interest {formatMoney(cut)} cut, hand over {formatMoney(issued - cut)}</div>;
}

function StartBooks({ onStarted }: { onStarted: () => void }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function start() {
    setBusy(true);
    setError("");
    try {
      await api("/api/periods", { body: { year, month } });
      onStarted();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <PageHeader title="Monthly records" subtitle="The books have not been started yet." />
      <div className="card">
        <h2>Start the books</h2>
        <p>Choose the first month you will feed into the system. Register the members first; anyone registered later is added automatically.</p>
        <p className="muted small">For members who already have savings or advances, enter their opening balances on the Registration form or the member&apos;s page before you start. They become the balances b/f of the first month.</p>
        {error && <Alert kind="error">{error}</Alert>}
        <div className="row">
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))} aria-label="Month">
            {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
          <input type="number" value={year} min={2000} max={2200} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year" style={{ width: 110 }} />
          <button className="btn" disabled={busy} onClick={start}>{busy ? "Starting..." : `Start with ${monthLabel(year, month)}`}</button>
        </div>
      </div>
    </div>
  );
}

function exportCsv(label: string, rows: EntryRow[], view: (r: EntryRow) => {
  openings: Openings; inputs: ManualInputs; computed: Computed; expected: number;
}) {
  const head = ["No", "Member", "Savings b/f", "Advance b/f", "Interest due", "Expected", "Amount brought", "Advance repaid", "Merry go round",
    "Interest paid", "Savings added", "Bonus to savings", "New advance", "Interest cut", "Cash handed over", "Savings c/f", "Advance c/f"];
  const m = (c: number) => formatMoney(c).replace(/,/g, "");
  const lines = rows.map((r) => {
    const v = view(r);
    const cut = v.computed.advance_interest_deducted;
    return [r.member.member_no, `"${r.member.full_name.replace(/"/g, '""')}"`, m(v.openings.savings_open),
      m(v.openings.advance_bal_open), m(interestDue(v.openings)), m(v.expected), m(v.inputs.amount_paid), m(v.inputs.advance_repaid),
      m(v.inputs.mgr_contribution), m(v.computed.advance_interest_paid), m(v.computed.savings_contribution),
      m(v.openings.bonus_credit), m(v.inputs.advance_issued), m(cut), m(v.inputs.advance_issued - cut),
      m(v.computed.savings_close), m(v.computed.advance_bal_close)].join(",");
  });
  const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `records-${label.replace(" ", "-").toLowerCase()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
