import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db } from "./supabase";
import { SESSION_COOKIE, verifySession, type Role, type Session } from "./session";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

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
    throw new Error(message);
  }
  return res.data;
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
