import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { actorName, check, requireUser, route } from "@/lib/server";

/** Chairman or administrator: reopen the previous month (only if nothing was fed in the new one). */
export const POST = route(async () => {
  const s = await requireUser();
  const id = check(await db().rpc("undo_roll", { p_actor: actorName(s) }));
  return NextResponse.json({ id });
});
