import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { audit, check, HttpError, readJson, requireUser, route } from "@/lib/server";
import { ensureOpenEntries } from "@/lib/entries";
import { memberFields } from "@/lib/members";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** One member with their month-by-month transactions. */
export const GET = route(async (_req: Request, { params }: Ctx) => {
  await requireUser();
  const { id } = await params;
  const member = check(await db().from("members").select("*").eq("id", id).maybeSingle());
  if (!member) throw new HttpError(404, "Member not found.");
  const entries = check(
    await db().from("member_entries").select("*, period:periods!inner(id, year, month, seq, status)").eq("member_id", id),
  );
  entries.sort((a: { period: { seq: number } }, b: { period: { seq: number } }) => b.period.seq - a.period.seq);
  const bonuses = check(
    await db()
      .from("bonus_allocations")
      .select("amount_cents, bonus:bonus_issues!inner(id, issued_at, payout, voided_at, note)")
      .eq("member_id", id),
  );
  // opening balances can be changed until the member's first month is rolled
  const opening_editable = !entries.some((e: { period: { status: string } }) => e.period.status === "closed");
  return NextResponse.json({ member, entries, bonuses, opening_editable });
});

/** Edit member details (chairman or administrator). */
export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const s = await requireUser();
  const { id } = await params;
  const body = await readJson(req);
  const before = check(await db().from("members").select("*").eq("id", id).maybeSingle());
  if (!before) throw new HttpError(404, "Member not found.");
  const changes = memberFields(body, false);
  const member = check(await db().from("members").update(changes).eq("id", id).select().single());

  if (member.status === "active") await ensureOpenEntries(s.username, [id]);
  const diff = Object.fromEntries(
    Object.entries(changes).filter(([k, v]) => before[k] !== v).map(([k, v]) => [k, { from: before[k], to: v }]),
  );
  await audit(s, "member_updated", { member_id: id, changes: diff });
  return NextResponse.json({ member });
});
