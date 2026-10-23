"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Alert, Loading, Money, PageHeader } from "@/components/ui";
import { api } from "@/lib/client";
import type { MemberListItem } from "@/lib/types";

export default function MembersPage() {
  const [members, setMembers] = useState<MemberListItem[] | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  useEffect(() => {
    api<{ members: MemberListItem[] }>("/api/members").then((d) => setMembers(d.members), (e) => setError(e.message));
  }, []);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (members ?? []).filter(
      (m) =>
        (showInactive || m.status === "active") &&
        (!needle || m.full_name.toLowerCase().includes(needle) || String(m.member_no) === needle ||
          (m.phone ?? "").includes(needle) || (m.national_id ?? "").toLowerCase().includes(needle)),
    );
  }, [members, q, showInactive]);

  const totals = list.reduce(
    (t, m) => ({ s: t.s + m.savings, a: t.a + m.advance_balance, r: t.r + m.registration_fee_cents }),
    { s: 0, a: 0, r: 0 },
  );

  return (
    <div className="stack">
      <PageHeader
        title="Member records"
        subtitle="Everyone in the group with their current balances."
        actions={<Link className="btn" href="/members/register">Register member</Link>}
      />
      {error && <Alert kind="error">{error}</Alert>}
      <div className="row">
        <input className="table-search" placeholder="Search name, number, phone or ID" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive</label>
      </div>
      {!members ? <Loading /> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>No.</th><th>Name</th><th>Phone</th><th>Joined</th><th>Status</th>
                <th className="num">Reg. fee</th><th className="num">Savings</th><th className="num">Advance balance</th>
              </tr>
            </thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.id}>
                  <td>{m.member_no}</td>
                  <td><Link href={`/members/${m.id}`}>{m.full_name}</Link></td>
                  <td>{m.phone ?? "-"}</td>
                  <td className="num">{m.joined_on}</td>
                  <td><span className={`badge ${m.status === "active" ? "badge-open" : "badge-closed"}`}>{m.status}</span></td>
                  <td className="num"><Money cents={m.registration_fee_cents} /></td>
                  <td className="num"><Money cents={m.savings} /></td>
                  <td className="num"><Money cents={m.advance_balance} dashZero /></td>
                </tr>
              ))}
              {!list.length && <tr><td colSpan={8} className="muted">No members found.</td></tr>}
            </tbody>
            {list.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={5}>Total ({list.length} members)</td>
                  <td className="num"><Money cents={totals.r} /></td>
                  <td className="num"><Money cents={totals.s} /></td>
                  <td className="num"><Money cents={totals.a} /></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
