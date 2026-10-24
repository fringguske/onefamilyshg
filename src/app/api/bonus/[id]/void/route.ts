import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { actorName, check, HttpError, readJson, requireUser, route, text } from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };

/** Chairman or administrator: cancel a bonus issued by mistake (while its month is still open). */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const s = await requireUser();
  const { id } = await params;
  const { reason } = await readJson<{ reason?: string }>(req);
  const why = text(reason, 300);
  if (!why) throw new HttpError(400, "Give a reason for voiding the bonus.");
  check(await db().rpc("void_bonus", { p_bonus_id: id, p_reason: why, p_actor: actorName(s) }));
  return NextResponse.json({ ok: true });
});
