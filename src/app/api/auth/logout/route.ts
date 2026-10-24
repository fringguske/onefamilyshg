import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";
import { audit, getSession, route } from "@/lib/server";

export const POST = route(async () => {
  const s = await getSession();
  if (s) await audit(s, "logout");
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
});
