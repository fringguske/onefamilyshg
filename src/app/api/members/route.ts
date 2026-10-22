import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { memberFields } from "@/lib/members";
import { audit, check, getOpenPeriod, readJson, requireUser, route } from "@/lib/server";
import type { MemberListItem } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Member records: everyone with their current balances. */
export const GET = route(async () => {
  await requireUser();
  const members = check(await db().from("members").select("*").order("member_no"));
  const latest = check(await db().from("periods").select("id").order("seq", { ascending: false }).limit(1).maybeSingle());
  const balances = new Map<string, { savings_close: number; loan_bal_close: number; advance_bal_close: number }>();
  if (latest) {
    const rows = check(
      await db().from("member_entries").select("member_id, savings_close, loan_bal_close, advance_bal_close").eq("period_id", latest.id),
    );
    for (const r of rows) balances.set(r.member_id, r);
  }
  const list: MemberListItem[] = members.map((m: MemberListItem) => {
    const b = balances.get(m.id);
    return {
      id: m.id,
      member_no: m.member_no,
      full_name: m.full_name,
      phone: m.phone,
      national_id: m.national_id,
      joined_on: m.joined_on,
      registration_fee_cents: m.registration_fee_cents,
      status: m.status,
      savings: b?.savings_close ?? 0,
      loan_balance: b?.loan_bal_close ?? 0,
      advance_balance: b?.advance_bal_close ?? 0,
    };
  });
  return NextResponse.json({ members: list });
});

/** Registration of a new member. */
export const POST = route(async (req: Request) => {
  const s = await requireUser();
  const body = await readJson(req);
  const row = memberFields(body, true);
  const member = check(await db().from("members").insert({ ...row, created_by: s.username }).select().single());

  // the new member appears in the month that is being fed right now
  const open = await getOpenPeriod();
  if (open) {
    check(await db().from("member_entries").insert({ period_id: open.id, member_id: member.id, updated_by: s.username }));
  }
  await audit(s, "member_registered", { member_id: member.id, member_no: member.member_no, ...row });
  return NextResponse.json({ member });
});
