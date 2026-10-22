import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { check, getSettings, HttpError, requireUser, route } from "@/lib/server";
import type { EntryRow, Period } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * "Load group records for this month".
 * Without ?period= it loads the open month. If the open month has just been
 * rolled into, the manual fields are empty and the balances b/f and interest
 * are already worked out.
 */
export const GET = route(async (req: Request) => {
  const s = await requireUser();
  const periodId = new URL(req.url).searchParams.get("period");
  const q = db().from("periods").select("*");
  const period: Period | null = check(await (periodId ? q.eq("id", periodId) : q.eq("status", "open")).maybeSingle());
  if (!period) {
    if (periodId) throw new HttpError(404, "Month not found.");
    return NextResponse.json({ period: null, rows: [] });
  }

  if (period.status === "open") {
    // every active member must have a row in the open month
    const active = check(await db().from("members").select("id").eq("status", "active"));
    if (active.length) {
      check(
        await db()
          .from("member_entries")
          .upsert(
            active.map((m: { id: string }) => ({ period_id: period.id, member_id: m.id, updated_by: s.username })),
            { onConflict: "period_id,member_id", ignoreDuplicates: true },
          ),
      );
    }
  }

  const [entries, earlier, settings] = await Promise.all([
    db()
      .from("member_entries")
      .select("*, member:members!inner(member_no, full_name, status)")
      .eq("period_id", period.id)
      .then(check),
    db().rpc("members_with_history", { p_seq: period.seq }).then(check),
    getSettings(),
  ]);
  const hasHistory = new Set<string>(earlier as string[]);
  const rows: EntryRow[] = entries
    .map((e: Omit<EntryRow, "is_first">) => ({ ...e, is_first: !hasHistory.has(e.member_id) }))
    .sort((a: EntryRow, b: EntryRow) => a.member.member_no - b.member.member_no);

  return NextResponse.json({
    period,
    rows,
    rates: { loan_rate_bps: settings.loan_rate_bps, advance_rate_bps: settings.advance_rate_bps },
    currency: settings.currency,
  });
});
