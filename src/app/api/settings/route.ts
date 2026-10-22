import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { isCents } from "@/lib/money";
import { audit, check, getSettings, HttpError, readJson, requireUser, route, text } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const s = await requireUser();
  return NextResponse.json({ settings: await getSettings(), me: { name: s.name, role: s.role, username: s.username } });
});

/** Administrator only. New interest rates apply from the next roll. */
export const PUT = route(async (req: Request) => {
  const s = await requireUser(["admin"]);
  const body = await readJson(req);
  const group_name = text(body.group_name, 80);
  const currency = text(body.currency, 8);
  if (!group_name || !currency) throw new HttpError(400, "Enter the group name and currency.");
  for (const k of ["loan_rate_bps", "advance_rate_bps"]) {
    const v = body[k];
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 10000) throw new HttpError(400, "Enter a rate between 0% and 100%.");
  }
  for (const k of ["registration_fee_cents", "opening_cash_cents", "opening_interest_pool_cents"]) {
    if (!isCents(body[k])) throw new HttpError(400, "One of the amounts is not valid.");
  }
  const before = await getSettings();
  const next = {
    group_name,
    currency,
    loan_rate_bps: body.loan_rate_bps,
    advance_rate_bps: body.advance_rate_bps,
    registration_fee_cents: body.registration_fee_cents,
    opening_cash_cents: body.opening_cash_cents,
    opening_interest_pool_cents: body.opening_interest_pool_cents,
    updated_at: new Date().toISOString(),
  };
  const settings = check(await db().from("settings").update(next).eq("id", 1).select().single());
  await audit(s, "settings_updated", { before, after: settings });
  return NextResponse.json({ settings });
});
