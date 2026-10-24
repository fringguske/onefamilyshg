import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { hashPassword } from "@/lib/password";
import { audit, check, HttpError, readJson, requireUser, route, text } from "@/lib/server";

type Ctx = { params: Promise<{ id: string }> };

/** Chairman or administrator: rename, reset password, or (de)activate a chairman. */
export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const s = await requireUser();
  const { id } = await params;
  const body = await readJson(req);
  const changes: Record<string, unknown> = {};
  if ("display_name" in body) {
    const name = text(body.display_name, 80);
    if (!name) throw new HttpError(400, "Enter the chairman's name.");
    changes.display_name = name;
  }
  if ("active" in body) {
    if (body.active !== true && id === s.sub) throw new HttpError(400, "You cannot disable your own account.");
    changes.active = body.active === true;
  }
  if ("password" in body) {
    const pw = String(body.password ?? "");
    if (pw.length < 8) throw new HttpError(400, "The password must have at least 8 characters.");
    changes.password_hash = await hashPassword(pw);
  }
  const user = check(
    await db().from("app_users").update(changes).eq("id", id).select("id, username, display_name, active, created_at").maybeSingle(),
  );
  if (!user) throw new HttpError(404, "Account not found.");
  await audit(s, "chairman_updated", { username: user.username, fields: Object.keys(changes) });
  return NextResponse.json({ user });
});
