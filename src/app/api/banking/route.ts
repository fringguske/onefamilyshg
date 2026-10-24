import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { audit, check, HttpError, requireUser, route } from "@/lib/server";

export const dynamic = "force-dynamic";

/** "View this month banking": the cash statement of one month (saved records only). */
export const GET = route(async (req: Request) => {
  const s = await requireUser();
  const periodId = new URL(req.url).searchParams.get("period");
  if (!periodId) throw new HttpError(400, "Invalid request.");
  const banking = check(await db().rpc("month_banking", { p_period_id: periodId }));
  if (!banking) throw new HttpError(404, "Month not found.");
  await audit(s, "banking_viewed", { period_id: periodId });
  return NextResponse.json({ banking });
});
