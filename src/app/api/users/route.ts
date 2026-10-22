import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { hashPassword } from "@/lib/password";
import { audit, check, HttpError, readJson, requireUser, route, text } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Administrator only: chairman accounts. */
export const GET = route(async () => {
  await requireUser(["admin"]);
  const users = check(await db().from("app_users").select("id, username, display_name, active, created_at").order("created_at"));
  return NextResponse.json({ users });
});

export const POST = route(async (req: Request) => {
  const s = await requireUser(["admin"]);
  const body = await readJson(req);
  const username = String(body.username ?? "").trim().toLowerCase();
  const display_name = text(body.display_name, 80);
  const password = String(body.password ?? "");
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new HttpError(400, "Username: 3 to 40 letters, numbers, dots or dashes.");
  if (username === (process.env.ADMIN_USERNAME ?? "").trim().toLowerCase()) throw new HttpError(400, "That username is reserved.");
  if (!display_name) throw new HttpError(400, "Enter the chairman's name.");
  if (password.length < 8) throw new HttpError(400, "The password must have at least 8 characters.");
  const user = check(
    await db()
      .from("app_users")
      .insert({ username, display_name, password_hash: await hashPassword(password) })
      .select("id, username, display_name, active, created_at")
      .single(),
  );
  await audit(s, "chairman_created", { username });
  return NextResponse.json({ user });
});
