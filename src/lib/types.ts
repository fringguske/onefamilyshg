import type { Computed, ManualInputs, Openings } from "./ledger";

export interface Period {
  id: string;
  year: number;
  month: number;
  seq: number;
  status: "open" | "closed";
  opened_at: string;
  closed_at: string | null;
  closed_by: string | null;
  mgr_member_id: string | null;
}

export interface EntryRow extends Openings, ManualInputs, Computed {
  id: string;
  period_id: string;
  member_id: string;
  notes: string | null;
  version: number;
  updated_at: string;
  updated_by: string | null;
  member: { member_no: number; full_name: string; status: string };
  /** true when this is the member's first month: opening balances may be typed */
  is_first: boolean;
}

export interface Settings {
  group_name: string;
  currency: string;
  advance_rate_bps: number;
  registration_fee_cents: number;
  mgr_contribution_cents: number;
  opening_cash_cents: number;
  opening_interest_pool_cents: number;
}

export interface MemberListItem {
  id: string;
  member_no: number;
  full_name: string;
  phone: string | null;
  national_id: string | null;
  joined_on: string;
  registration_fee_cents: number;
  status: "active" | "inactive";
  savings: number;
  advance_balance: number;
}
