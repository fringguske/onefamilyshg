// Signed session cookie (HS256 JWT). Edge-safe: used by middleware too.
import { SignJWT, jwtVerify } from "jose";

export type Role = "admin" | "chairman";
export interface Session {
  sub: string; // "admin" or the chairman's app_users.id
  username: string;
  name: string;
  role: Role;
}

export const SESSION_COOKIE = "mgr_session";
export const SESSION_HOURS = 12;

function key(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET is missing or shorter than 32 characters.");
  return new TextEncoder().encode(s);
}

export async function signSession(s: Session): Promise<string> {
  return new SignJWT({ username: s.username, name: s.name, role: s.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(s.sub)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(key());
}

export async function verifySession(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    const role = payload.role;
    if ((role !== "admin" && role !== "chairman") || typeof payload.sub !== "string") return null;
    return { sub: payload.sub, username: String(payload.username), name: String(payload.name), role };
  } catch {
    return null;
  }
}
