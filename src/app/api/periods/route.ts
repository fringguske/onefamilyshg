import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { isCents } from "@/lib/money";
import { actorName, check, HttpError, readJson, requireUser, route } from "@/lib/server";
import { COST_ACCOUNTS, type CostAccount } from "@/lib/types";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireUser();
  const periods = check(await db().from("periods").select("*").order("seq", { ascending: false }));
  return NextResponse.json({ periods });
});

/** Start the books: creates the first month. */
export const POST = route(async (req: Request) => {
  const s = await requireUser();
  const { year, month } = await readJson<{ year?: number; month?: number }>(req);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month! < 1 || month! > 12 || year! < 2000 || year! > 2200) {
    throw new HttpError(400, "Choose a valid starting month.");
  }
  const id = check(await db().rpc("start_books", { p_year: year, p_month: month, p_actor: actorName(s) }));
  return NextResponse.json({ id });
});

/** Set the open month's transaction cost (one amount for the month) and the account it is paid from. */
export const PUT = route(async (req: Request) => {
  const s = await requireUser();
  const { period_id, transaction_cost, transaction_cost_from = "interest" } =
    await readJson<{ period_id?: string; transaction_cost?: unknown; transaction_cost_from?: unknown }>(req);
  if (!period_id) throw new HttpError(400, "Invalid request.");
  if (!isCents(transaction_cost)) throw new HttpError(400, "Enter a valid transaction cost.");
  if (!COST_ACCOUNTS.includes(transaction_cost_from as CostAccount)) throw new HttpError(400, "Choose where the transaction cost is paid from.");
  check(await db().rpc("set_transaction_cost", {
    p_period_id: period_id, p_amount: transaction_cost, p_from: transaction_cost_from, p_actor: actorName(s),
  }));
  return NextResponse.json({ ok: true });
});
