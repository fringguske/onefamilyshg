import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { bonusPool, planBonus } from "@/lib/bonus";
import { actorName, check, getOpenPeriod, HttpError, readJson, requireUser, route, text } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireUser();
  const [pool, period, bonuses] = await Promise.all([
    bonusPool(),
    getOpenPeriod(),
    db()
      .from("bonus_issues")
      .select("*, period:periods(year, month, status), allocations:bonus_allocations(amount_cents, member:members(member_no, full_name))")
      .order("issued_at", { ascending: false })
      .then(check),
  ]);
  return NextResponse.json({ pool, period, bonuses });
});

/**
 * Issue a bonus. Safety checks:
 *  - only from interest of rolled (locked) months, never more than the pool
 *  - the person must have previewed the exact shares
 *  - shares are recalculated here; if anything changed since the preview, nothing is issued
 *  - recorded in the audit log; the administrator can void it while the month is open
 */
export const POST = route(async (req: Request) => {
  const s = await requireUser();
  const body = await readJson<{
    total?: number; method?: string; payout?: string; note?: string;
    allocations?: { member_id: string; amount: number }[];
  }>(req);
  if (body.payout !== "savings" && body.payout !== "cash") throw new HttpError(400, "Choose how the bonus is paid.");

  const plan = await planBonus(body.total, body.method);
  const previewed = new Map((body.allocations ?? []).map((a) => [a.member_id, a.amount]));
  const same =
    previewed.size === plan.allocations.length && plan.allocations.every((a) => previewed.get(a.member_id) === a.amount);
  if (!same) throw new HttpError(409, "The records changed since your preview. Preview again before issuing.");

  const id = check(
    await db().rpc("issue_bonus", {
      p_period_id: plan.period.id,
      p_total: plan.total,
      p_method: plan.method,
      p_payout: body.payout,
      p_note: text(body.note, 300),
      p_actor: actorName(s),
      p_allocations: plan.allocations.map((a) => ({ member_id: a.member_id, amount: a.amount })),
    }),
  );
  return NextResponse.json({ id });
});
