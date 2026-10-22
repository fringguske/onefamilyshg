import "server-only";
import { db } from "./supabase";
import { splitBonus } from "./ledger";
import { isCents } from "./money";
import { check, getOpenPeriod, HttpError } from "./server";

export type BonusMethod = "savings_share" | "equal";
export type BonusPayout = "savings" | "cash";

export async function bonusPool(): Promise<number> {
  return Number(check(await db().rpc("bonus_pool_cents")));
}

/** Works out each active member's share. Used for the preview and again when issuing. */
export async function planBonus(total: unknown, method: unknown) {
  if (!isCents(total) || total <= 0) throw new HttpError(400, "Enter a bonus amount above zero.");
  if (method !== "savings_share" && method !== "equal") throw new HttpError(400, "Choose how to share the bonus.");
  const period = await getOpenPeriod();
  if (!period) throw new HttpError(422, "Start the books first.");
  const pool = await bonusPool();
  if (total > pool) throw new HttpError(422, "The bonus is more than the interest pool available for bonuses.");

  const all = check(
    await db()
      .from("member_entries")
      .select("member_id, savings_close, member:members!inner(member_no, full_name, status)")
      .eq("period_id", period.id),
  ) as unknown as { member_id: string; savings_close: number; member: { member_no: number; full_name: string; status: string } }[];
  const rows = all.filter((r) => r.member.status === "active");
  if (!rows.length) throw new HttpError(422, "There are no active members to share a bonus with.");
  rows.sort((a, b) => a.member.member_no - b.member.member_no);

  const shares = splitBonus(
    total,
    rows.map((r) => ({ member_id: r.member_id, member_no: r.member.member_no, weight: method === "equal" ? 1 : r.savings_close })),
  );
  const allocations = shares.map((sh, i) => ({
    member_id: sh.member_id,
    member_no: rows[i].member.member_no,
    full_name: rows[i].member.full_name,
    savings: rows[i].savings_close,
    amount: sh.amount,
  }));
  return { period, pool, total, method, allocations };
}
