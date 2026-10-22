import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { hashPassword, verifyPassword } from "@/lib/password";
import { audit, check, HttpError, readJson, requireUser, route } from "@/lib/server";

/** A chairman changes their own password. */
export const POST = route(async (req: Request) => {
  const s = await requireUser(["chairman"]);
  const { current, next } = await readJson<{ current?: string; next?: string }>(req);
  if (!next || next.length < 8) throw new HttpError(400, "The new password must have at least 8 characters.");
  const user = check(await db().from("app_users").select("password_hash").eq("id", s.sub).single());
  if (!(await verifyPassword(String(current ?? ""), user.password_hash))) {
    throw new HttpError(400, "Your current password is wrong.");
  }
  check(await db().from("app_users").update({ password_hash: await hashPassword(next) }).eq("id", s.sub));
  await audit(s, "password_changed");
  return NextResponse.json({ ok: true });
});
