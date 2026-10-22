import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { safeEqual, verifyPassword } from "@/lib/password";
import { SESSION_COOKIE, SESSION_HOURS, signSession, type Session } from "@/lib/session";
import { audit, check, HttpError, readJson, route } from "@/lib/server";

const MAX_FAILURES = 5;
const WINDOW_MINUTES = 15;

export const POST = route(async (req: Request) => {
  const body = await readJson<{ username?: string; password?: string }>(req);
  const username = String(body.username ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!username || !password) throw new HttpError(400, "Enter your username and password.");

  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
  const { count } = await db()
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .eq("action", "login_failed")
    .eq("actor", username)
    .gte("at", since);
  if ((count ?? 0) >= MAX_FAILURES) {
    throw new HttpError(429, `Too many wrong attempts. Try again in ${WINDOW_MINUTES} minutes.`);
  }

  const session = await authenticate(username, password);
  if (!session) {
    await audit(username, "login_failed");
    await new Promise((r) => setTimeout(r, 400));
    throw new HttpError(401, "Wrong username or password.");
  }

  await audit(session, "login");
  const res = NextResponse.json({ ok: true, role: session.role });
  res.cookies.set(SESSION_COOKIE, await signSession(session), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
  return res;
});

async function authenticate(username: string, password: string): Promise<Session | null> {
  const adminUser = (process.env.ADMIN_USERNAME ?? "").trim().toLowerCase();
  if (adminUser && username === adminUser) {
    const hash = process.env.ADMIN_PASSWORD_HASH;
    const plain = process.env.ADMIN_PASSWORD;
    const ok = hash ? await verifyPassword(password, hash) : !!plain && safeEqual(password, plain);
    return ok ? { sub: "admin", username: adminUser, name: "Administrator", role: "admin" } : null;
  }
  const user = check(
    await db().from("app_users").select("id, username, display_name, password_hash, active").eq("username", username).maybeSingle(),
  );
  if (!user || !user.active) return null;
  if (!(await verifyPassword(password, user.password_hash))) return null;
  return { sub: user.id, username: user.username, name: user.display_name, role: "chairman" };
}
