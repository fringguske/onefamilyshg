import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { check, requireUser, route } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireUser(["admin"]);
  const log = check(await db().from("audit_log").select("*").order("at", { ascending: false }).limit(300));
  return NextResponse.json({ log });
});
