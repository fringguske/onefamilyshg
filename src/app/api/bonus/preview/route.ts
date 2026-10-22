import { NextResponse } from "next/server";
import { planBonus } from "@/lib/bonus";
import { readJson, requireUser, route } from "@/lib/server";

export const POST = route(async (req: Request) => {
  await requireUser();
  const body = await readJson<{ total?: number; method?: string }>(req);
  const plan = await planBonus(body.total, body.method);
  return NextResponse.json({ pool: plan.pool, total: plan.total, method: plan.method, allocations: plan.allocations });
});
