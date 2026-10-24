import { NextResponse } from "next/server";
import { planBonus } from "@/lib/bonus";
import { audit, readJson, requireUser, route } from "@/lib/server";

export const POST = route(async (req: Request) => {
  const s = await requireUser();
  const body = await readJson<{ total?: number; method?: string }>(req);
  const plan = await planBonus(body.total, body.method);
  await audit(s, "bonus_previewed", { total_cents: plan.total, method: plan.method, pool_cents: plan.pool });
  return NextResponse.json({ pool: plan.pool, total: plan.total, method: plan.method, allocations: plan.allocations });
});
