import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { check, getSettings, requireUser, route } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireUser();
  const [summary, settings] = await Promise.all([db().rpc("group_summary").then(check), getSettings()]);
  return NextResponse.json({ summary, settings });
});
