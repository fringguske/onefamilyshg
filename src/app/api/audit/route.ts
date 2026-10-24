import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { monthLabel } from "@/lib/period";
import { audit, check, HttpError, readJson, requireUser, route, text } from "@/lib/server";

export const dynamic = "force-dynamic";

/** The audit trail. ?views=0 leaves out page views, ?actor= shows one person. */
export const GET = route(async (req: Request) => {
  const s = await requireUser();
  const params = new URL(req.url).searchParams;
  const actor = params.get("actor");
  let q = db().from("audit_log").select("*").order("at", { ascending: false }).limit(500);
  if (params.get("views") === "0") q = q.neq("action", "page_view");
  if (actor) q = q.eq("actor", actor);
  const log = check(await q);
  const actors = check(await db().from("app_users").select("username").order("username")) as { username: string }[];
  await audit(s, "audit_viewed", { filter: { page_views: params.get("views") !== "0", actor: actor ?? "everyone" } });
  const admin = (process.env.ADMIN_USERNAME ?? "").trim().toLowerCase();
  return NextResponse.json({ log, actors: [...(admin ? [`admin:${admin}`] : []), ...actors.map((u) => `chairman:${u.username}`)] });
});

const PAGES: Record<string, string> = {
  "/": "Group summary",
  "/month": "Monthly records",
  "/mgr": "Merry go round",
  "/members": "Member records",
  "/members/register": "Registration",
  "/bonus": "Bonus",
  "/settings": "Settings",
};

/** Things that happen only in the browser: opening a page, printing, exporting. */
const CLIENT_ACTIONS = ["page_view", "printed", "csv_exported", "records_loaded"];

export const POST = route(async (req: Request) => {
  const s = await requireUser();
  const body = await readJson<{ action?: string; path?: string; period?: string; details?: Record<string, unknown> }>(req);
  const action = String(body.action ?? "");
  if (!CLIENT_ACTIONS.includes(action)) throw new HttpError(400, "Invalid request.");
  const path = text(body.path, 200) ?? "/";
  const details: Record<string, unknown> = { page: await pageName(path) };
  const period = text(body.period, 64);
  if (period) details.month = await monthName(period);
  else if (path === "/month") details.month = "open month";
  await audit(s, action, details);
  return NextResponse.json({ ok: true });
});

async function pageName(path: string): Promise<string> {
  if (PAGES[path]) return PAGES[path];
  const member = /^\/members\/([0-9a-f-]{36})$/i.exec(path);
  if (member) {
    const m = check(await db().from("members").select("member_no, full_name").eq("id", member[1]).maybeSingle());
    return m ? `Member page: #${m.member_no} ${m.full_name}` : "Member page";
  }
  return path;
}

async function monthName(id: string): Promise<string> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return id;
  const p = check(await db().from("periods").select("year, month").eq("id", id).maybeSingle());
  return p ? monthLabel(p.year, p.month) : id;
}
