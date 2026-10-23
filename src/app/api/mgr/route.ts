import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { actorName, check, getSettings, HttpError, readJson, requireUser, route } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Merry go round: who took it each month and how much the others gave them. */
export const GET = route(async () => {
  await requireUser();
  const [periods, members, entries, settings] = await Promise.all([
    db().from("periods").select("id, year, month, seq, status, mgr_member_id").order("seq", { ascending: false }).then(check),
    db().from("members").select("id, member_no, full_name, status").order("member_no").then(check),
    db().from("member_entries").select("period_id, mgr_contribution").gt("mgr_contribution", 0).then(check),
    getSettings(),
  ]);
  const totals = new Map<string, { total: number; payers: number }>();
  for (const e of entries as { period_id: string; mgr_contribution: number }[]) {
    const t = totals.get(e.period_id) ?? { total: 0, payers: 0 };
    t.total += e.mgr_contribution;
    t.payers += 1;
    totals.set(e.period_id, t);
  }
  const months = (periods as { id: string; mgr_member_id: string | null }[]).map((p) => ({
    ...p,
    total: totals.get(p.id)?.total ?? 0,
    payers: totals.get(p.id)?.payers ?? 0,
  }));
  return NextResponse.json({ months, members, contribution: settings.mgr_contribution_cents });
});

/** Choose who takes the merry go round in the open month (null clears it). */
export const PUT = route(async (req: Request) => {
  const s = await requireUser();
  const { period_id, member_id } = await readJson<{ period_id?: string; member_id?: string | null }>(req);
  if (!period_id || (member_id !== null && typeof member_id !== "string")) throw new HttpError(400, "Invalid request.");
  check(await db().rpc("set_mgr_recipient", { p_period_id: period_id, p_member_id: member_id, p_actor: actorName(s) }));
  return NextResponse.json({ ok: true });
});
