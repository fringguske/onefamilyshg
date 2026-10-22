import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { actorName, check, HttpError, readJson, requireUser, route } from "@/lib/server";

/** Roll the open month: lock it and carry balances into the next month. */
export const POST = route(async (req: Request) => {
  const s = await requireUser();
  const { period_id } = await readJson<{ period_id?: string }>(req);
  if (!period_id) throw new HttpError(400, "Invalid request.");
  const id = check(await db().rpc("roll_period", { p_period_id: period_id, p_actor: actorName(s) }));
  return NextResponse.json({ id });
});
