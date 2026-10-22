import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { HttpError } from "./errors";
import { db } from "./supabase";
import { SESSION_COOKIE, verifySession, type Role, type Session } from "./session";

export { HttpError };

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const s = await verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!s) return null;
  if (s.role === "chairman") {
    // a chairman who has been deactivated is logged out immediately
    const { data } = await db().from("app_users").select("active").eq("id", s.sub).maybeSingle();
    if (!data?.active) return null;
  }
  return s;
}

export async function requireUser(roles: Role[] = ["admin", "chairman"]): Promise<Session> {
  const s = await getSession();
  if (!s) throw new HttpError(401, "Please log in again.");
  if (!roles.includes(s.role)) throw new HttpError(403, "Only the administrator can do this.");
  return s;
}

/** Wraps a route handler: turns thrown errors into JSON { error } responses. */
export function route<C>(fn: (req: Request, ctx: C) => Promise<Response>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
      console.error(e);
      return NextResponse.json({ error: "Something went wrong on the server. Please try again." }, { status: 500 });
    }
  };
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid request.");
  }
}

/**
 * Throws a readable error for a failed database call, otherwise returns its data.
 * The database client is untyped, so rows come back as `any`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function check(res: { data: unknown; error: { message: string; code?: string } | null }): any {
  if (res.error) {
    const { message, code } = res.error;
    if (code === "23505") throw new HttpError(409, "That record already exists (duplicate value).");
    if (code === "23514") throw new HttpError(422, "The figures do not add up, so the record was not saved. Reload and try again.");
    // messages raised by our own SQL functions are written for the user
    if (code === "P0001") throw new HttpError(422, message);
    throw setupError(code, message) ?? new Error(message);
  }
  return res.data;
}

/** Explains the usual set-up mistakes (schema not run, wrong key, wrong URL) instead of a generic error. */
function setupError(code: string | undefined, message: string): HttpError | null {
  console.error("Database error", code, message);
  if (code === "42P01" || code === "PGRST205" || code === "PGRST202" || /does not exist|schema cache/i.test(message)) {
    return new HttpError(500, "Database set-up: the tables are missing. Run supabase/schema.sql in the Supabase SQL Editor, then reload this page.");
  }
  if (code === "42501" || /permission denied/i.test(message)) {
    return new HttpError(500, "Database set-up: the server key has no access to the tables. Run the latest supabase/schema.sql again in the Supabase SQL Editor, and check that SUPABASE_SERVICE_ROLE_KEY in Vercel is the secret / service_role key, not the anon or publishable key.");
  }
  if (code === "PGRST116") {
    return new HttpError(500, "Database set-up: a required row was not found. Run supabase/schema.sql in the Supabase SQL Editor, and check that SUPABASE_SERVICE_ROLE_KEY is the secret / service_role key, not the anon or publishable key.");
  }
  if (/invalid api key|jwt|unauthorized|no api key/i.test(message) || code === "PGRST301") {
    return new HttpError(500, "Database set-up: Supabase rejected the key. Copy SUPABASE_SERVICE_ROLE_KEY again from Supabase (Project Settings > API Keys), save it in Vercel and redeploy.");
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|getaddrinfo/i.test(message)) {
    return new HttpError(500, "Database set-up: cannot reach Supabase. Check SUPABASE_URL in Vercel (it looks like https://xxxx.supabase.co) and redeploy.");
  }
  return null;
}

export async function audit(actor: Session | string, action: string, details: Record<string, unknown> = {}) {
  const name = typeof actor === "string" ? actor : actorName(actor);
  await db().from("audit_log").insert({ actor: name, action, details });
}

export function actorName(s: Session): string {
  return `${s.role}:${s.username}`;
}

export async function getOpenPeriod() {
  return check(await db().from("periods").select("*").eq("status", "open").maybeSingle());
}

export async function getSettings() {
  return check(await db().from("settings").select("*").eq("id", 1).single());
}

export function text(v: unknown, max = 200): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > max) throw new HttpError(400, `Text is too long (max ${max} characters).`);
  return s;
}
