"use client";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MoneyInput } from "@/components/MoneyInput";
import { Alert, Loading, Modal, Money, PageHeader } from "@/components/ui";
import { api, readStore, useUnsavedWarning, writeStore } from "@/lib/client";
import { computeEntry, interestDue, interestOn, MANUAL_FIELDS, OPENING_FIELDS, type ManualInputs, type Openings } from "@/lib/ledger";
import { centsToInput, formatMoney, formatPercent, parseMoney } from "@/lib/money";
import { MONTH_NAMES, monthLabel, nextMonth } from "@/lib/period";
import type { EntryRow, Period } from "@/lib/types";

type ManualKey = (typeof MANUAL_FIELDS)[number];
type OpeningKey = (typeof OPENING_FIELDS)[number];

/** Unsaved typing for one member, kept in the browser until it is saved. */
interface Draft {
  base: number; // the record version the draft was started from
  f: Record<ManualKey, string>;
  o?: Record<OpeningKey, string>;
}
type Drafts = Record<string, Draft>;

interface MonthData {
  period: Period | null;
  rows: EntryRow[];
  rates?: { loan_rate_bps: number; advance_rate_bps: number };
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
        setDrafts(Object.fromEntries(Object.entries(stored).filter(([id]) => ids.has(id))));
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

  const rates = data?.rates ?? { loan_rate_bps: 1000, advance_rate_bps: 1000 };

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
        savings_open: row.savings_open, loan_bal_open: row.loan_bal_open, advance_bal_open: row.advance_bal_open,
        loan_interest_bf: row.loan_interest_bf, advance_interest_bf: row.advance_interest_bf,
        loan_interest_charged: row.loan_interest_charged, advance_interest_charged: row.advance_interest_charged,
        bonus_credit: row.bonus_credit,
      };
      const openText = {} as Record<OpeningKey, string>;
      for (const k of OPENING_FIELDS) {
        openText[k] = d?.o ? d.o[k] : centsToInput(row[k]);
        if (d?.o) {
          const c = parseMoney(d.o[k]);
          if (c === null) invalid = true;
          openings[k] = c ?? 0;
        }
      }
      if (d?.o) {
        openings.loan_interest_charged = interestOn(openings.loan_bal_open, rates.loan_rate_bps);
        openings.advance_interest_charged = interestOn(openings.advance_bal_open, rates.advance_rate_bps);
      }
      const { computed, errors } = computeEntry(openings, inputs);
      if (invalid) errors.unshift("One of the amounts is not a valid number (use digits, up to 2 decimals).");
      return { text, openText, inputs, openings, computed, errors, draft: d, conflict: !!d && d.base !== row.version };
    },
    [drafts, rates.loan_rate_bps, rates.advance_rate_bps],
  );

  function edit(row: EntryRow, field: ManualKey | OpeningKey, value: string, opening = false) {
    setJustSaved((s) => ({ ...s, [row.id]: false }));
    setDrafts((all) => {
      const cur: Draft = all[row.id] ?? {
        base: row.version,
        f: Object.fromEntries(MANUAL_FIELDS.map((k) => [k, centsToInput(row[k])])) as Record<ManualKey, string>,
      };
      const next: Draft = { ...cur, f: { ...cur.f } };
      if (opening) {
        next.o = { ...(cur.o ?? (Object.fromEntries(OPENING_FIELDS.map((k) => [k, centsToInput(row[k])])) as Record<OpeningKey, string>)) };
        next.o[field as OpeningKey] = value;
      } else {
        next.f[field as ManualKey] = value;
      }
      // a draft that matches the saved record is not a draft any more
      const same =
        MANUAL_FIELDS.every((k) => parseMoney(next.f[k]) === row[k]) &&
        (!next.o || OPENING_FIELDS.every((k) => parseMoney(next.o![k]) === row[k]));
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
        openings: v.draft.o ? Object.fromEntries(OPENING_FIELDS.map((k) => [k, v.openings[k]])) : null,
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
    setNotice(failed ? `${ok} saved, ${failed} not saved — check the rows marked in red.` : `${ok} record(s) saved.`);
  }

  const rows = data?.rows ?? [];
  const shown = useMemo(() => {
    const n = filter.trim().toLowerCase();
    return n ? rows.filter((r) => r.member.full_name.toLowerCase().includes(n) || String(r.member.member_no) === n) : rows;
  }, [rows, filter]);

  const totals = useMemo(() => {
    const t = { sb: 0, lb: 0, ab: 0, due: 0, paid: 0, lr: 0, ar: 0, sav: 0, li: 0, ai: 0, sc: 0, lc: 0, ac: 0 };
    for (const r of rows) {
      const v = view(r);
      t.sb += v.openings.savings_open; t.lb += v.openings.loan_bal_open; t.ab += v.openings.advance_bal_open;
      t.due += interestDue(v.openings).total; t.paid += v.inputs.amount_paid; t.lr += v.inputs.loan_repaid;
      t.ar += v.inputs.advance_repaid; t.sav += v.computed.savings_contribution; t.li += v.inputs.loan_issued;
      t.ai += v.inputs.advance_issued; t.sc += v.computed.savings_close; t.lc += v.computed.loan_bal_close; t.ac += v.computed.advance_bal_close;
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

  return (
    <div className="stack">
      <PageHeader
        title={`Monthly records — ${label}`}
        subtitle={
          editable ? (
            <>Feed what each member brought. Interest is deducted first, then repayments; the balance goes to savings. <span className="badge badge-open">Open</span></>
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
            <button className="btn btn-secondary" disabled={loading} onClick={() => (requested ? router.push("/month") : load(null))}>
              {loading ? "Loading…" : "Load group records for this month"}
            </button>
            <button className="btn btn-secondary" onClick={() => exportCsv(label, rows, view)}>Export CSV</button>
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
            <button className="btn btn-secondary" onClick={() => setRollOpen(true)}>Roll to {monthLabel(nm.year, nm.month)} →</button>
          </>
        )}
      </div>

      <div className="table-wrap sheet">
        <table>
          <thead>
            <tr>
              <th rowSpan={2}>Member</th>
              <th className="group" colSpan={3}>Brought forward (auto)</th>
              <th className="group" colSpan={4}>Fed this month</th>
              <th className="group" colSpan={1}>Auto</th>
              <th className="group" colSpan={2}>Issued this month</th>
              <th className="group" colSpan={3}>Carried forward (auto)</th>
              {editable && <th rowSpan={2}></th>}
            </tr>
            <tr>
              <th className="num">Savings</th><th className="num">Loan</th><th className="num">Advance</th>
              <th className="num">Interest due</th><th className="num">Amount brought</th><th className="num">Loan repaid</th><th className="num">Advance repaid</th>
              <th className="num">Savings added</th>
              <th className="num">New loan</th><th className="num">New advance</th>
              <th className="num">Savings</th><th className="num">Loan</th><th className="num">Advance</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => {
              const v = view(row);
              const due = interestDue(v.openings);
              const err = rowErrors[row.id] || (v.draft ? v.errors.join(" ") : "");
              const canEditOpenings = editable && row.is_first;
              const money = (k: ManualKey, lbl: string) => (
                <td className="num" data-label={lbl}>
                  {editable ? (
                    <MoneyInput label={`${lbl} — ${row.member.full_name}`} value={v.text[k]} onChange={(x) => edit(row, k, x)} />
                  ) : (
                    <Money cents={row[k]} dashZero />
                  )}
                </td>
              );
              const opening = (k: OpeningKey, lbl: string) => (
                <td className={`num${canEditOpenings ? "" : " auto"}`} data-label={lbl}>
                  {canEditOpenings ? (
                    <MoneyInput label={`${lbl} — ${row.member.full_name}`} value={v.openText[k]} onChange={(x) => edit(row, k, x, true)} />
                  ) : (
                    <Money cents={v.openings[k]} />
                  )}
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
                      {row.member.status !== "active" && " · inactive"}
                      {canEditOpenings && " · first month: type balances b/f"}
                    </div>
                    {err && <div className="row-errors">{err}</div>}
                    {v.conflict && (
                      <div className="row-errors">
                        This record was changed by someone else after you started typing.{" "}
                        <button className="linkish" onClick={() => keepDraft(row)}>Keep my figures</button> ·{" "}
                        <button className="linkish" onClick={() => discard(row.id)}>Use saved figures</button>
                      </div>
                    )}
                  </td>
                  {opening("savings_open", "Savings b/f")}
                  {opening("loan_bal_open", "Loan b/f")}
                  {opening("advance_bal_open", "Advance b/f")}
                  <td className="num auto" data-label="Interest due" title={due.total ? `Loan ${formatMoney(due.loan)} + advance ${formatMoney(due.advance)}` : undefined}>
                    <Money cents={due.total} dashZero />
                  </td>
                  {money("amount_paid", "Amount brought")}
                  {money("loan_repaid", "Loan repaid")}
                  {money("advance_repaid", "Advance repaid")}
                  <td className="num auto" data-label="Savings added"><Money cents={v.computed.savings_contribution} dashZero /></td>
                  {money("loan_issued", "New loan")}
                  {money("advance_issued", "New advance")}
                  <td className="num auto" data-label="Savings c/f"><Money cents={v.computed.savings_close} /></td>
                  <td className="num auto" data-label="Loan c/f"><Money cents={v.computed.loan_bal_close} /></td>
                  <td className="num auto" data-label="Advance c/f"><Money cents={v.computed.advance_bal_close} /></td>
                  {editable && (
                    <td data-label="">
                      {v.draft ? (
                        <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                          <button className="btn btn-small" disabled={saving[row.id] || v.errors.length > 0 || v.conflict} onClick={() => saveRow(row)}>
                            {saving[row.id] ? "…" : "Save"}
                          </button>
                          <button className="btn btn-small btn-secondary" onClick={() => discard(row.id)} title="Undo my typing">↺</button>
                        </div>
                      ) : justSaved[row.id] ? (
                        <span className="badge badge-saved">Saved ✓</span>
                      ) : null}
                    </td>
                  )}
                </tr>
              );
            })}
            {!shown.length && <tr><td colSpan={15} className="muted">No members in this month. Register members first.</td></tr>}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr>
                <td>Totals ({rows.length})</td>
                <td className="num"><Money cents={totals.sb} /></td>
                <td className="num"><Money cents={totals.lb} /></td>
                <td className="num"><Money cents={totals.ab} /></td>
                <td className="num"><Money cents={totals.due} /></td>
                <td className="num"><Money cents={totals.paid} /></td>
                <td className="num"><Money cents={totals.lr} /></td>
                <td className="num"><Money cents={totals.ar} /></td>
                <td className="num"><Money cents={totals.sav} /></td>
                <td className="num"><Money cents={totals.li} /></td>
                <td className="num"><Money cents={totals.ai} /></td>
                <td className="num"><Money cents={totals.sc} /></td>
                <td className="num"><Money cents={totals.lc} /></td>
                <td className="num"><Money cents={totals.ac} /></td>
                {editable && <td></td>}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <p className="small muted">
        Interest due = {formatPercent(rates.loan_rate_bps)}% of the loan b/f + {formatPercent(rates.advance_rate_bps)}% of the advance b/f, plus any interest left unpaid
        from earlier months. Interest goes to the group pool (see Group summary). Press Enter in a row to save it.
      </p>

      {rollOpen && editable && (
        <RollDialog
          period={period}
          rows={rows}
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

function RollDialog({ period, rows, unsaved, onClose, onRolled }: {
  period: Period; rows: EntryRow[]; unsaved: number; onClose: () => void; onRolled: () => void;
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
    <Modal title={`Roll ${label} → ${monthLabel(nm.year, nm.month)}`} onClose={onClose}>
      <p>Rolling will:</p>
      <ul>
        <li><strong>Lock {label}</strong> — its records can no longer be changed.</li>
        <li>Carry every member&apos;s savings, loan and advance balance into {monthLabel(nm.year, nm.month)}.</li>
        <li>Work out next month&apos;s interest on the loans and advances carried forward.</li>
        <li>Leave the amounts to be fed for {monthLabel(nm.year, nm.month)} empty.</li>
      </ul>
      {error && <Alert kind="error">{error}</Alert>}
      {unsaved > 0 ? (
        <Alert kind="error">{unsaved} record(s) are typed but not saved. Save or undo them before rolling.</Alert>
      ) : (
        <>
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
        <button className="btn" disabled={busy || unsaved > 0 || !checked} onClick={roll}>{busy ? "Rolling…" : `Roll to ${monthLabel(nm.year, nm.month)}`}</button>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
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
        <p className="muted small">For members who already have savings, loans or advances, you will type their balances b/f in this first month.</p>
        {error && <Alert kind="error">{error}</Alert>}
        <div className="row">
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))} aria-label="Month">
            {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
          <input type="number" value={year} min={2000} max={2200} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year" style={{ width: 110 }} />
          <button className="btn" disabled={busy} onClick={start}>{busy ? "Starting…" : `Start with ${monthLabel(year, month)}`}</button>
        </div>
      </div>
    </div>
  );
}

function exportCsv(label: string, rows: EntryRow[], view: (r: EntryRow) => { openings: Openings; inputs: ManualInputs; computed: ReturnType<typeof computeEntry>["computed"] }) {
  const head = ["No", "Member", "Savings b/f", "Loan b/f", "Advance b/f", "Interest due", "Amount brought", "Loan repaid",
    "Advance repaid", "Interest paid", "Savings added", "Bonus to savings", "New loan", "New advance", "Savings c/f", "Loan c/f", "Advance c/f"];
  const m = (c: number) => formatMoney(c).replace(/,/g, "");
  const lines = rows.map((r) => {
    const v = view(r);
    return [r.member.member_no, `"${r.member.full_name.replace(/"/g, '""')}"`, m(v.openings.savings_open), m(v.openings.loan_bal_open),
      m(v.openings.advance_bal_open), m(interestDue(v.openings).total), m(v.inputs.amount_paid), m(v.inputs.loan_repaid),
      m(v.inputs.advance_repaid), m(v.computed.loan_interest_paid + v.computed.advance_interest_paid), m(v.computed.savings_contribution),
      m(v.openings.bonus_credit), m(v.inputs.loan_issued), m(v.inputs.advance_issued), m(v.computed.savings_close),
      m(v.computed.loan_bal_close), m(v.computed.advance_bal_close)].join(",");
  });
  const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `records-${label.replace(" ", "-").toLowerCase()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
