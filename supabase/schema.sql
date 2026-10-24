-- =====================================================================
--  One Family Merry-Go-Round: Supabase / PostgreSQL schema
--  Run this whole file once in Supabase > SQL Editor > New query > Run.
--  It is safe to run again (tables use IF NOT EXISTS, functions are replaced).
--
--  ACCURACY RULES
--  * Every money value is a BIGINT number of cents (KES 1,250.50 = 125050).
--    No floating point is ever stored, so totals can never drift.
--  * Interest rates are integer basis points (10% = 1000).
--  * CHECK constraints re-verify the arithmetic of every monthly record, so
--    even a bug in the app cannot save a record whose numbers do not add up.
--  * Months that have been rolled are locked by a trigger.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Settings (exactly one row)
-- ---------------------------------------------------------------------
create table if not exists settings (
  id                          smallint primary key default 1 check (id = 1),
  group_name                  text    not null default 'One Family Merry-Go-Round',
  currency                    text    not null default 'KES',
  advance_rate_bps            integer not null default 1000 check (advance_rate_bps between 0 and 10000),
  registration_fee_cents      bigint  not null default 0 check (registration_fee_cents >= 0),
  -- cash the group already held when the books were started in this system
  opening_cash_cents          bigint  not null default 0,
  -- interest the group had already earned (and not shared) before this system
  opening_interest_pool_cents bigint  not null default 0 check (opening_interest_pool_cents >= 0),
  updated_at                  timestamptz not null default now()
);
insert into settings (id) values (1) on conflict (id) do nothing;
-- what each member gives the merry go round recipient every month
alter table settings add column if not exists mgr_contribution_cents bigint not null default 0 check (mgr_contribution_cents >= 0);
-- fines are fed by the chairman per member, so there is no standard fine amount
alter table settings drop column if exists fine_cents;
alter table settings drop column if exists loan_rate_bps;

-- ---------------------------------------------------------------------
-- Chairman accounts (the administrator lives in Vercel env variables)
-- ---------------------------------------------------------------------
create table if not exists app_users (
  id            uuid primary key default gen_random_uuid(),
  username      text not null unique check (username = lower(username) and length(username) between 3 and 40),
  display_name  text not null,
  password_hash text not null,
  role          text not null default 'chairman' check (role in ('chairman')),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Members (registration)
-- ---------------------------------------------------------------------
create table if not exists members (
  id                     uuid primary key default gen_random_uuid(),
  member_no              integer not null unique,
  full_name              text not null check (length(btrim(full_name)) > 0),
  phone                  text,
  national_id            text unique,
  joined_on              date not null default current_date,
  registration_fee_cents bigint not null default 0 check (registration_fee_cents >= 0),
  status                 text not null default 'active' check (status in ('active', 'inactive')),
  notes                  text,
  created_at             timestamptz not null default now(),
  created_by             text
);
-- Balances an existing member brings into the system. Used as the balances b/f
-- of their first month only; after that the roll carries everything.
alter table members add column if not exists opening_savings_cents bigint not null default 0 check (opening_savings_cents >= 0);
alter table members add column if not exists opening_advance_cents bigint not null default 0 check (opening_advance_cents >= 0);
alter table members drop column if exists opening_loan_cents;

-- Member numbers run 1, 2, 3, ... with no gaps. An identity column used up a
-- number even when a registration failed, so the next free number is now
-- given out inside the registration itself and is released if it fails.
alter table members alter column member_no drop identity if exists;
alter table members alter column member_no set not null;

create or replace function assign_member_no() returns trigger
language plpgsql as $$
begin
  perform pg_advisory_xact_lock(424243);
  select coalesce(max(member_no), 0) + 1 into new.member_no from members;
  return new;
end $$;

drop trigger if exists members_assign_no on members;
create trigger members_assign_no
  before insert on members
  for each row execute function assign_member_no();

-- close any gaps left by the old numbering (keeps everyone in the same order)
update members m set member_no = -r.n
  from (select id, row_number() over (order by member_no) as n from members) r
 where r.id = m.id and m.member_no <> r.n;
update members set member_no = -member_no where member_no < 0;

-- ---------------------------------------------------------------------
-- Months (the group meets once a month). Only one month is open at a time.
-- ---------------------------------------------------------------------
create table if not exists periods (
  id        uuid primary key default gen_random_uuid(),
  year      integer not null check (year between 2000 and 2200),
  month     integer not null check (month between 1 and 12),
  seq       integer generated always as (year * 12 + month - 1) stored unique,
  status    text not null default 'open' check (status in ('open', 'closed')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by text
);
create unique index if not exists periods_one_open on periods ((status)) where status = 'open';
-- the member who takes the merry go round this month
alter table periods add column if not exists mgr_member_id uuid references members (id) on delete restrict;
-- what the group paid in transaction costs this month (e.g. sending money);
-- taken out of the interest pool, never out of any member's money
alter table periods add column if not exists transaction_cost bigint not null default 0 check (transaction_cost >= 0);
-- the account the transaction cost is paid from: the interest or the registration fees
alter table periods add column if not exists transaction_cost_from text not null default 'interest'
  check (transaction_cost_from in ('interest', 'registration_fees'));

-- ---------------------------------------------------------------------
-- Member transactions: one row per member per month
-- ---------------------------------------------------------------------
create table if not exists member_entries (
  id        uuid primary key default gen_random_uuid(),
  period_id uuid not null references periods (id) on delete cascade,
  member_id uuid not null references members (id) on delete restrict,

  -- Brought forward (calculated by the roll)
  savings_open             bigint not null default 0,
  advance_bal_open         bigint not null default 0,
  advance_interest_bf      bigint not null default 0,   -- unpaid advance interest from earlier months
  advance_interest_charged bigint not null default 0,   -- this month: rate x advance still unpaid after the month it was due

  -- Fed manually by the chairman
  amount_paid    bigint not null default 0,   -- total cash the member brought
  advance_repaid bigint not null default 0,
  advance_issued bigint not null default 0,
  notes          text,

  -- Calculated
  advance_interest_paid    bigint not null default 0,
  savings_contribution     bigint not null default 0,  -- the balance after interest and repayments
  bonus_credit             bigint not null default 0,  -- bonus credited to savings this month
  savings_close            bigint not null default 0,
  advance_bal_close        bigint not null default 0,
  advance_interest_arrears bigint not null default 0,

  version    integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by text,

  unique (period_id, member_id)
);
-- given by this member to the month's merry go round recipient, out of the amount brought
alter table member_entries add column if not exists mgr_contribution bigint not null default 0;
-- interest cut from this month's new advance: the member receives advance_issued minus this
alter table member_entries add column if not exists advance_interest_deducted bigint not null default 0;
-- a fine fed by the chairman for this member, out of the amount brought (never expected)
alter table member_entries add column if not exists fine_paid bigint not null default 0;
-- transaction costs are kept once per month on periods, not per member
alter table member_entries drop column if exists transaction_cost;

-- Loans are not used by the group. Dropping these also drops the old checks that used them.
alter table member_entries drop column if exists loan_bal_open,
                           drop column if exists loan_interest_bf,
                           drop column if exists loan_interest_charged,
                           drop column if exists loan_repaid,
                           drop column if exists loan_issued,
                           drop column if exists loan_interest_paid,
                           drop column if exists loan_bal_close,
                           drop column if exists loan_interest_arrears;

alter table member_entries
  drop constraint if exists entry_non_negative,
  drop constraint if exists entry_cash_identity,
  drop constraint if exists entry_interest_cap,
  drop constraint if exists entry_interest_first,
  drop constraint if exists entry_repay_cap,
  drop constraint if exists entry_loan_identity,
  drop constraint if exists entry_advance_identity,
  drop constraint if exists entry_arrears_identity,
  drop constraint if exists entry_savings_identity,
  drop constraint if exists entry_deducted_cap;

-- ---------------------------------------------------------------------
-- Lock rolled months
-- ---------------------------------------------------------------------
create or replace function guard_closed_period() returns trigger
language plpgsql as $$
declare
  st text;
begin
  if tg_op = 'UPDATE' and new.period_id <> old.period_id then
    raise exception 'A record cannot be moved to another month.';
  end if;
  select status into st from periods where id = coalesce(new.period_id, old.period_id);
  if st = 'closed' then
    raise exception 'This month has been rolled, so its records are locked.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

drop trigger if exists member_entries_guard on member_entries;
create trigger member_entries_guard
  before insert or update or delete on member_entries
  for each row execute function guard_closed_period();

-- The merry go round used to be handed over on top of the amount brought; it is now
-- part of it. Add it to the amount brought of earlier records (rolled ones too) so
-- they follow the same rule. Records already moved over no longer match the old rule.
alter table member_entries disable trigger member_entries_guard;
update member_entries
   set amount_paid = amount_paid + mgr_contribution
 where mgr_contribution > 0
   and amount_paid = advance_interest_paid + advance_repaid + savings_contribution;
alter table member_entries enable trigger member_entries_guard;

-- Interest due is fed by the chairman. It starts as what the roll worked out
-- (unpaid b/f + this month's charge) and can be changed. When the column is
-- first added, earlier records get exactly what the roll worked out for them.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'member_entries'
                   and column_name = 'advance_interest_due') then
    alter table member_entries add column advance_interest_due bigint not null default 0;
    alter table member_entries disable trigger member_entries_guard;
    update member_entries set advance_interest_due = advance_interest_bf + advance_interest_charged;
    alter table member_entries enable trigger member_entries_guard;
  end if;
end $$;

alter table member_entries
  add constraint entry_non_negative check (
    savings_open >= 0 and advance_bal_open >= 0 and
    advance_interest_bf >= 0 and advance_interest_charged >= 0 and advance_interest_due >= 0 and
    amount_paid >= 0 and advance_repaid >= 0 and advance_issued >= 0 and mgr_contribution >= 0 and fine_paid >= 0 and
    advance_interest_deducted >= 0 and advance_interest_paid >= 0 and savings_contribution >= 0 and bonus_credit >= 0 and savings_close >= 0 and
    advance_bal_close >= 0 and advance_interest_arrears >= 0),
  -- the cash brought is fully accounted for
  add constraint entry_cash_identity check (
    amount_paid = advance_interest_paid + advance_repaid + mgr_contribution + fine_paid + savings_contribution),
  -- interest is never over-collected
  add constraint entry_interest_cap check (advance_interest_paid <= advance_interest_due),
  -- interest is deducted before any of the advance is repaid
  add constraint entry_interest_first check (
    advance_repaid = 0 or advance_interest_paid = advance_interest_due),
  -- the interest cut from a new advance is never more than the advance
  add constraint entry_deducted_cap check (advance_interest_deducted <= advance_issued),
  -- you cannot repay more than what was owed at the start of the month
  add constraint entry_repay_cap check (advance_repaid <= advance_bal_open),
  add constraint entry_advance_identity check (advance_bal_close = advance_bal_open + advance_issued - advance_repaid),
  add constraint entry_arrears_identity check (
    advance_interest_arrears = advance_interest_due - advance_interest_paid),
  add constraint entry_savings_identity check (savings_close = savings_open + savings_contribution + bonus_credit);
create index if not exists member_entries_member on member_entries (member_id);

-- ---------------------------------------------------------------------
-- Bonus issuance (shares out the interest pool)
-- ---------------------------------------------------------------------
create table if not exists bonus_issues (
  id          uuid primary key default gen_random_uuid(),
  period_id   uuid not null references periods (id) on delete restrict,
  total_cents bigint not null check (total_cents > 0),
  method      text not null check (method in ('savings_share', 'equal')),
  payout      text not null check (payout in ('savings', 'cash')),
  note        text,
  issued_at   timestamptz not null default now(),
  issued_by   text not null,
  voided_at   timestamptz,
  voided_by   text,
  void_reason text
);

create table if not exists bonus_allocations (
  bonus_id     uuid not null references bonus_issues (id) on delete cascade,
  member_id    uuid not null references members (id) on delete restrict,
  amount_cents bigint not null check (amount_cents > 0),
  primary key (bonus_id, member_id)
);

-- ---------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------
create table if not exists audit_log (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  actor   text not null,
  action  text not null,
  details jsonb
);
create index if not exists audit_log_at on audit_log (at desc);
create index if not exists audit_log_action on audit_log (action, actor, at desc);

-- ---------------------------------------------------------------------
-- Security: the browser never talks to the database. Only the server
-- (with the service-role key) can read or write. RLS with no policies
-- blocks the public anon key completely.
-- ---------------------------------------------------------------------
alter table settings          enable row level security;
alter table app_users         enable row level security;
alter table members           enable row level security;
alter table periods           enable row level security;
alter table member_entries    enable row level security;
alter table bonus_issues      enable row level security;
alter table bonus_allocations enable row level security;
alter table audit_log         enable row level security;

-- Everyone contributes to the merry go round, the month's recipient included,
-- so the old check that stopped the recipient contributing is removed.
drop trigger if exists member_entries_mgr_guard on member_entries;
drop function if exists guard_mgr_contribution();

-- ---------------------------------------------------------------------
-- Interest: rate x balance, rounded half-up to the nearest cent
-- (pure integer arithmetic, identical to interestOn() in src/lib/ledger.ts)
-- ---------------------------------------------------------------------
create or replace function interest_on(p_balance bigint, p_bps integer) returns bigint
language sql immutable as $$
  select (p_balance * p_bps + 5000) / 10000
$$;

-- ---------------------------------------------------------------------
-- Start the books (creates the first month)
-- ---------------------------------------------------------------------
create or replace function start_books(p_year integer, p_month integer, p_actor text) returns uuid
language plpgsql as $$
declare
  pid uuid;
begin
  perform pg_advisory_xact_lock(424242);
  if exists (select 1 from periods) then
    raise exception 'The books have already been started.';
  end if;
  insert into periods (year, month) values (p_year, p_month) returning id into pid;
  -- first month: balances b/f are each member's opening balances. The interest
  -- on an opening advance was cut when it was taken, so the advance is simply due.
  insert into member_entries (
    period_id, member_id, savings_open, advance_bal_open, savings_close, advance_bal_close)
  select pid, m.id, m.opening_savings_cents, m.opening_advance_cents,
         m.opening_savings_cents, m.opening_advance_cents
  from members m
  where m.status = 'active';
  insert into audit_log (actor, action, details)
    values (p_actor, 'start_books', jsonb_build_object('year', p_year, 'month', p_month));
  return pid;
end $$;

-- ---------------------------------------------------------------------
-- ROLL: lock the open month and carry every balance into the next month.
-- Next month's manual fields start empty; late interest is calculated here.
-- An advance is due in full the month after it is issued (its interest was cut
-- when it was issued). Whatever of it is still unpaid at the end of that month
-- is charged interest again, and so on every month until it is repaid.
-- p_period_id must be the month the user is looking at (stops double rolls).
-- ---------------------------------------------------------------------
create or replace function roll_period(p_period_id uuid, p_actor text) returns uuid
language plpgsql as $$
declare
  cur periods%rowtype;
  s   settings%rowtype;
  nid uuid;
  ny  integer;
  nm  integer;
begin
  perform pg_advisory_xact_lock(424242);
  select * into cur from periods where status = 'open' for update;
  if not found then
    raise exception 'There is no open month to roll.';
  end if;
  if cur.id <> p_period_id then
    raise exception 'This month has already been rolled. Reload the page.';
  end if;
  select * into s from settings where id = 1;

  -- make sure no active member is left out
  insert into member_entries (period_id, member_id)
    select cur.id, m.id from members m where m.status = 'active'
  on conflict (period_id, member_id) do nothing;

  update periods set status = 'closed', closed_at = now(), closed_by = p_actor where id = cur.id;

  if cur.month = 12 then ny := cur.year + 1; nm := 1;
  else ny := cur.year; nm := cur.month + 1;
  end if;
  insert into periods (year, month) values (ny, nm) returning id into nid;

  insert into member_entries (
    period_id, member_id,
    savings_open, advance_bal_open, advance_interest_bf, advance_interest_charged, advance_interest_due,
    savings_close, advance_bal_close, advance_interest_arrears)
  select
    nid, x.member_id,
    x.savings_close, x.advance_bal_close, x.advance_interest_arrears, x.ai, x.advance_interest_arrears + x.ai,
    x.savings_close, x.advance_bal_close, x.advance_interest_arrears + x.ai
  from (
    -- an advance issued without its interest cut (one saved before interest was cut
    -- at issue) is charged in the usual way instead
    select e.*, interest_on(e.advance_bal_open - e.advance_repaid
                            + case when e.advance_interest_deducted = 0 then e.advance_issued else 0 end,
                            s.advance_rate_bps) as ai
    from member_entries e
    join members m on m.id = e.member_id
    where e.period_id = cur.id
      and (m.status = 'active' or e.savings_close > 0 or e.advance_bal_close > 0 or e.advance_interest_arrears > 0)
  ) x;

  insert into audit_log (actor, action, details)
    values (p_actor, 'roll', jsonb_build_object('from', format('%s-%s', cur.year, lpad(cur.month::text, 2, '0')),
                                                'to',   format('%s-%s', ny, lpad(nm::text, 2, '0'))));
  return nid;
end $$;

-- ---------------------------------------------------------------------
-- UNDO ROLL (chairman or administrator): only while nothing has been fed in the new month
-- ---------------------------------------------------------------------
create or replace function undo_roll(p_actor text) returns uuid
language plpgsql as $$
declare
  cur  periods%rowtype;
  prev periods%rowtype;
begin
  perform pg_advisory_xact_lock(424242);
  select * into cur from periods where status = 'open' for update;
  if not found then
    raise exception 'There is no open month.';
  end if;
  select * into prev from periods where seq = cur.seq - 1 and status = 'closed' for update;
  if not found then
    raise exception 'There is no earlier month to go back to.';
  end if;
  if exists (select 1 from member_entries
             where period_id = cur.id
               and (amount_paid + advance_repaid + advance_issued + mgr_contribution + fine_paid + bonus_credit > 0
                    or advance_interest_due <> advance_interest_bf + advance_interest_charged
                    or coalesce(btrim(notes), '') <> ''))
     or cur.mgr_member_id is not null or cur.transaction_cost > 0 then
    raise exception 'Records have already been fed for the new month. Clear them first, then undo the roll.';
  end if;
  if exists (select 1 from bonus_issues where period_id = cur.id) then
    raise exception 'A bonus was issued in the new month, so the roll cannot be undone.';
  end if;

  delete from member_entries where period_id = cur.id;
  delete from periods where id = cur.id;
  update periods set status = 'open', closed_at = null, closed_by = null where id = prev.id;

  insert into audit_log (actor, action, details)
    values (p_actor, 'undo_roll', jsonb_build_object('reopened', format('%s-%s', prev.year, lpad(prev.month::text, 2, '0'))));
  return prev.id;
end $$;

-- ---------------------------------------------------------------------
-- Interest pool available for bonuses: advance interest and fines, less the
-- transaction costs paid from it.
-- Only interest from ROLLED (locked) months counts, so a later correction
-- of the open month can never make an issued bonus exceed the pool.
-- ---------------------------------------------------------------------
create or replace function bonus_pool_cents() returns bigint
language sql stable as $$
  select (select opening_interest_pool_cents from settings where id = 1)
       + coalesce((select sum(e.advance_interest_paid + e.advance_interest_deducted + e.fine_paid)
                   from member_entries e join periods p on p.id = e.period_id
                   where p.status = 'closed'), 0)
       - coalesce((select sum(transaction_cost) from periods
                   where status = 'closed' and transaction_cost_from = 'interest'), 0)
       - coalesce((select sum(total_cents) from bonus_issues where voided_at is null), 0)
$$;

-- ---------------------------------------------------------------------
-- ISSUE BONUS. Allocations are worked out by the app and re-checked here.
-- p_allocations: [{"member_id": "...", "amount": 12345}, ...]
-- ---------------------------------------------------------------------
create or replace function issue_bonus(
  p_period_id uuid, p_total bigint, p_method text, p_payout text,
  p_note text, p_actor text, p_allocations jsonb) returns uuid
language plpgsql as $$
declare
  cur       periods%rowtype;
  pool      bigint;
  alloc_sum bigint;
  bid       uuid;
begin
  perform pg_advisory_xact_lock(424242);
  select * into cur from periods where status = 'open';
  if not found or cur.id <> p_period_id then
    raise exception 'The open month has changed. Reload the page and preview again.';
  end if;
  if p_total is null or p_total <= 0 then
    raise exception 'The bonus amount must be more than zero.';
  end if;
  pool := bonus_pool_cents();
  if p_total > pool then
    raise exception 'The bonus is more than the interest pool available for bonuses.';
  end if;
  select coalesce(sum((a ->> 'amount')::bigint), 0) into alloc_sum from jsonb_array_elements(p_allocations) a;
  if alloc_sum <> p_total then
    raise exception 'The member shares do not add up to the bonus total.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_allocations) a where (a ->> 'amount')::bigint < 0) then
    raise exception 'A member share cannot be negative.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_allocations) a
             where not exists (select 1 from member_entries e
                               where e.period_id = cur.id and e.member_id = (a ->> 'member_id')::uuid)) then
    raise exception 'A member in the bonus list is not in this month''s records.';
  end if;

  insert into bonus_issues (period_id, total_cents, method, payout, note, issued_by)
    values (cur.id, p_total, p_method, p_payout, nullif(btrim(coalesce(p_note, '')), ''), p_actor)
    returning id into bid;

  insert into bonus_allocations (bonus_id, member_id, amount_cents)
    select bid, (a ->> 'member_id')::uuid, (a ->> 'amount')::bigint
    from jsonb_array_elements(p_allocations) a
    where (a ->> 'amount')::bigint > 0;

  if p_payout = 'savings' then
    update member_entries e
       set bonus_credit  = e.bonus_credit + ba.amount_cents,
           savings_close = e.savings_close + ba.amount_cents
      from bonus_allocations ba
     where ba.bonus_id = bid and e.period_id = cur.id and e.member_id = ba.member_id;
  end if;

  insert into audit_log (actor, action, details)
    values (p_actor, 'bonus_issue', jsonb_build_object('bonus_id', bid, 'total_cents', p_total,
                                                       'method', p_method, 'payout', p_payout));
  return bid;
end $$;

-- ---------------------------------------------------------------------
-- VOID BONUS (chairman or administrator): only while its month is still open
-- ---------------------------------------------------------------------
create or replace function void_bonus(p_bonus_id uuid, p_reason text, p_actor text) returns void
language plpgsql as $$
declare
  b  bonus_issues%rowtype;
  st text;
begin
  perform pg_advisory_xact_lock(424242);
  select * into b from bonus_issues where id = p_bonus_id for update;
  if not found then
    raise exception 'Bonus not found.';
  end if;
  if b.voided_at is not null then
    raise exception 'This bonus was already voided.';
  end if;
  select status into st from periods where id = b.period_id;
  if st <> 'open' then
    raise exception 'The month of this bonus has been rolled, so it can no longer be voided.';
  end if;
  if b.payout = 'savings' then
    update member_entries e
       set bonus_credit  = e.bonus_credit - ba.amount_cents,
           savings_close = e.savings_close - ba.amount_cents
      from bonus_allocations ba
     where ba.bonus_id = b.id and e.period_id = b.period_id and e.member_id = ba.member_id;
  end if;
  update bonus_issues set voided_at = now(), voided_by = p_actor, void_reason = p_reason where id = b.id;
  insert into audit_log (actor, action, details)
    values (p_actor, 'bonus_void', jsonb_build_object('bonus_id', b.id, 'reason', p_reason));
end $$;

-- ---------------------------------------------------------------------
-- MERRY GO ROUND: choose (or clear) who takes it in the open month
-- ---------------------------------------------------------------------
create or replace function set_mgr_recipient(p_period_id uuid, p_member_id uuid, p_actor text) returns void
language plpgsql as $$
declare
  cur periods%rowtype;
begin
  perform pg_advisory_xact_lock(424242);
  select * into cur from periods where id = p_period_id for update;
  if not found or cur.status <> 'open' then
    raise exception 'This month has been rolled, so its records are locked.';
  end if;
  if p_member_id is not null
     and not exists (select 1 from member_entries where period_id = cur.id and member_id = p_member_id) then
    raise exception 'This member is not in this month''s records.';
  end if;
  update periods set mgr_member_id = p_member_id where id = cur.id;
  insert into audit_log (actor, action, details)
    values (p_actor, 'mgr_recipient_set', jsonb_build_object('period_id', cur.id, 'from', cur.mgr_member_id, 'to', p_member_id));
end $$;

-- ---------------------------------------------------------------------
-- Registration fees left once the transaction costs paid from them are taken out
-- (optionally leaving out one month, so its cost can be changed)
-- ---------------------------------------------------------------------
create or replace function registration_fees_left(p_except uuid default null) returns bigint
language sql stable as $$
  select coalesce((select sum(registration_fee_cents) from members), 0)
       - coalesce((select sum(transaction_cost) from periods
                   where transaction_cost_from = 'registration_fees'
                     and id is distinct from p_except), 0)
$$;

-- ---------------------------------------------------------------------
-- TRANSACTION COST: what the group paid in the open month (one amount),
-- and the account it is paid from (the interest or the registration fees)
-- ---------------------------------------------------------------------
drop function if exists set_transaction_cost(uuid, bigint, text);
create or replace function set_transaction_cost(p_period_id uuid, p_amount bigint, p_from text, p_actor text) returns void
language plpgsql as $$
declare
  cur  periods%rowtype;
  left_ bigint;
begin
  perform pg_advisory_xact_lock(424242);
  select * into cur from periods where id = p_period_id for update;
  if not found or cur.status <> 'open' then
    raise exception 'This month has been rolled, so its records are locked.';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'The transaction cost cannot be negative.';
  end if;
  if p_from is null or p_from not in ('interest', 'registration_fees') then
    raise exception 'Choose where the transaction cost is paid from.';
  end if;
  if p_from = 'registration_fees' then
    left_ := registration_fees_left(cur.id);
    if p_amount > left_ then
      raise exception 'The registration fees left (%) are less than the transaction cost.', to_char(left_ / 100.0, 'FM999,999,999,990.00');
    end if;
  end if;
  update periods set transaction_cost = p_amount, transaction_cost_from = p_from where id = cur.id;
  insert into audit_log (actor, action, details)
    values (p_actor, 'transaction_cost_set', jsonb_build_object(
      'period_id', cur.id, 'from', cur.transaction_cost, 'to', p_amount,
      'account_from', cur.transaction_cost_from, 'account_to', p_from));
end $$;

-- ---------------------------------------------------------------------
-- Members who already have records before a given month
-- (everyone else may have opening balances typed in)
-- ---------------------------------------------------------------------
create or replace function members_with_history(p_seq integer) returns setof uuid
language sql stable as $$
  select distinct e.member_id
  from member_entries e join periods p on p.id = e.period_id
  where p.seq < p_seq
$$;

-- ---------------------------------------------------------------------
-- MONTH BANKING: the cash statement of one month. Banking b/f is the opening
-- cash plus everything banked and paid out in the earlier months, so the
-- latest month's banking c/f is the cash at hand on the group summary.
-- ---------------------------------------------------------------------
create or replace function month_banking(p_period_id uuid) returns json
language sql stable as $$
  with bounds as (
    select min(seq) as first_seq, max(seq) as last_seq from periods
  ),
  -- a registration fee is banked in the month the member joined; fees of members
  -- who joined before the books were started are banked in the first month
  fees as (
    select greatest(b.first_seq, least(b.last_seq,
             (extract(year from m.joined_on) * 12 + extract(month from m.joined_on) - 1)::integer)) as seq,
           sum(m.registration_fee_cents) as fees
    from members m cross join bounds b
    group by 1
  ),
  ent as (
    select period_id,
           count(*)                                     as members,
           count(*) filter (where amount_paid > 0)      as members_paid,
           sum(amount_paid)                             as collected,
           sum(savings_contribution)                    as savings,
           sum(advance_interest_paid)                   as interest_paid,
           sum(advance_repaid)                          as advances_repaid,
           sum(mgr_contribution)                        as mgr_collected,
           sum(fine_paid)                               as fines,
           sum(advance_issued)                          as advances_issued,
           sum(advance_interest_deducted)               as interest_cut,
           sum(bonus_credit)                            as bonus_credited,
           sum(savings_open)                            as savings_bf,
           sum(savings_close)                           as savings_cf,
           sum(advance_bal_open)                        as advances_bf,
           sum(advance_bal_close)                       as advances_cf,
           sum(advance_interest_due)                    as interest_due,
           sum(advance_interest_arrears)                as interest_arrears
    from member_entries
    group by period_id
  ),
  cash_bonus as (
    select period_id, sum(total_cents) as bonus_cash
    from bonus_issues where voided_at is null and payout = 'cash'
    group by period_id
  ),
  months as (
    select p.id, p.seq, p.year, p.month, p.status, p.transaction_cost, p.transaction_cost_from,
           (select full_name from members where id = p.mgr_member_id) as mgr_recipient,
           coalesce(f.fees, 0)               as fees,
           coalesce(e.members, 0)            as members,
           coalesce(e.members_paid, 0)       as members_paid,
           coalesce(e.collected, 0)          as collected,
           coalesce(e.savings, 0)            as savings,
           coalesce(e.interest_paid, 0)      as interest_paid,
           coalesce(e.advances_repaid, 0)    as advances_repaid,
           coalesce(e.mgr_collected, 0)      as mgr_collected,
           coalesce(e.fines, 0)              as fines,
           -- the merry go round leaves the bank once it is given to the recipient
           case when p.mgr_member_id is null then 0 else coalesce(e.mgr_collected, 0) end as mgr_paid,
           coalesce(e.advances_issued, 0)    as advances_issued,
           coalesce(e.interest_cut, 0)       as interest_cut,
           coalesce(e.bonus_credited, 0)     as bonus_credited,
           coalesce(e.savings_bf, 0)         as savings_bf,
           coalesce(e.savings_cf, 0)         as savings_cf,
           coalesce(e.advances_bf, 0)        as advances_bf,
           coalesce(e.advances_cf, 0)        as advances_cf,
           coalesce(e.interest_due, 0)       as interest_due,
           coalesce(e.interest_arrears, 0)   as interest_arrears,
           coalesce(c.bonus_cash, 0)         as bonus_cash
    from periods p
    left join ent e        on e.period_id = p.id
    left join fees f       on f.seq = p.seq
    left join cash_bonus c on c.period_id = p.id
  ),
  flow as (
    -- a new advance is handed over less the interest cut from it
    select m.*, m.fees + m.collected - m.mgr_paid - (m.advances_issued - m.interest_cut)
                - m.transaction_cost - m.bonus_cash as net
    from months m
  )
  select json_build_object(
    'period',           json_build_object('id', cur.id, 'year', cur.year, 'month', cur.month, 'status', cur.status),
    'first_month',      cur.seq = (select first_seq from bounds),
    'banking_bf',       bf.amount,
    'fees',             cur.fees,
    'collected',        cur.collected,
    'savings',          cur.savings,
    'interest_paid',    cur.interest_paid,
    'advances_repaid',  cur.advances_repaid,
    'mgr_collected',    cur.mgr_collected,
    'mgr_paid',         cur.mgr_paid,
    'mgr_recipient',    cur.mgr_recipient,
    'fines',            cur.fines,
    'advances_issued',  cur.advances_issued,
    'interest_cut',     cur.interest_cut,
    'transaction_cost', cur.transaction_cost,
    'transaction_cost_from', cur.transaction_cost_from,
    'bonus_cash',       cur.bonus_cash,
    'banking_cf',       bf.amount + cur.net,
    'bonus_credited',   cur.bonus_credited,
    'savings_bf',       cur.savings_bf,
    'savings_cf',       cur.savings_cf,
    'advances_bf',      cur.advances_bf,
    'advances_cf',      cur.advances_cf,
    'interest_due',     cur.interest_due,
    'interest_arrears', cur.interest_arrears,
    'members',          cur.members,
    'members_paid',     cur.members_paid
  )
  from flow cur
  cross join lateral (
    select (select opening_cash_cents from settings where id = 1)
         + coalesce((select sum(net) from flow where seq < cur.seq), 0) as amount
  ) bf
  where cur.id = p_period_id
$$;

-- ---------------------------------------------------------------------
-- GROUP SUMMARY
-- ---------------------------------------------------------------------
create or replace function group_summary() returns json
language sql stable as $$
  with latest as (
    select * from periods order by seq desc limit 1
  ),
  bal as (
    select coalesce(sum(savings_close), 0)            as total_savings,
           coalesce(sum(advance_bal_close), 0)        as advances_outstanding,
           coalesce(sum(advance_interest_arrears), 0) as interest_arrears
    from member_entries where period_id = (select id from latest)
  ),
  flows as (
    select coalesce(sum(amount_paid), 0)           as total_collected,
           coalesce(sum(savings_contribution), 0)  as savings_contributed,
           coalesce(sum(advance_issued), 0)        as advances_issued,
           coalesce(sum(advance_repaid), 0)        as advances_repaid,
           coalesce(sum(advance_interest_paid + advance_interest_deducted), 0) as advance_interest,
           coalesce(sum(advance_interest_deducted), 0) as interest_deducted,
           coalesce(sum(mgr_contribution), 0)      as mgr_total,
           coalesce(sum(fine_paid), 0)             as fines,
           coalesce(sum(mgr_contribution) filter (where p.mgr_member_id is not null), 0) as mgr_paid
    from member_entries e join periods p on p.id = e.period_id
  ),
  costs as (
    select coalesce(sum(transaction_cost), 0)                                                         as transaction_costs,
           coalesce(sum(transaction_cost) filter (where transaction_cost_from = 'interest'), 0)          as costs_from_interest,
           coalesce(sum(transaction_cost) filter (where transaction_cost_from = 'registration_fees'), 0) as costs_from_fees
    from periods
  ),
  bon as (
    select coalesce(sum(total_cents) filter (where voided_at is null), 0)                      as bonus_total,
           coalesce(sum(total_cents) filter (where voided_at is null and payout = 'cash'), 0)  as bonus_cash
    from bonus_issues
  ),
  mem as (
    select count(*) filter (where status = 'active') as active_members,
           count(*)                                  as all_members,
           coalesce(sum(registration_fee_cents), 0)  as registration_fees
    from members
  ),
  s as (select * from settings where id = 1)
  select json_build_object(
    'latest_period',        (select json_build_object('id', id, 'year', year, 'month', month, 'status', status) from latest),
    'total_savings',        bal.total_savings,
    'advances_outstanding', bal.advances_outstanding,
    'interest_arrears',     bal.interest_arrears,
    'total_collected',      flows.total_collected,
    'savings_contributed',  flows.savings_contributed,
    'advances_issued',      flows.advances_issued,
    'advances_repaid',      flows.advances_repaid,
    'advance_interest',     flows.advance_interest,
    'opening_interest',     s.opening_interest_pool_cents,
    'transaction_costs',    costs.transaction_costs,
    'costs_from_interest',  costs.costs_from_interest,
    'costs_from_fees',      costs.costs_from_fees,
    -- fines go into the interest pool; each month's transaction cost is paid out of
    -- the interest or the registration fees
    'total_interest',       s.opening_interest_pool_cents + flows.advance_interest + flows.fines - costs.costs_from_interest,
    'fines',                flows.fines,
    'mgr_total',            flows.mgr_total,
    'mgr_paid',             flows.mgr_paid,
    'bonus_total',          bon.bonus_total,
    'bonus_cash',           bon.bonus_cash,
    'bonus_pool_available', bonus_pool_cents(),
    'registration_fees',    mem.registration_fees,
    'registration_fees_left', mem.registration_fees - costs.costs_from_fees,
    'opening_cash',         s.opening_cash_cents,
    -- merry go round money is given to the recipient once they are chosen, and a
    -- new advance is paid out less the interest cut from it
    'cash_at_hand',         s.opening_cash_cents + mem.registration_fees + flows.total_collected - flows.mgr_paid
                              - (flows.advances_issued - flows.interest_deducted) - costs.transaction_costs - bon.bonus_cash,
    'active_members',       mem.active_members,
    'all_members',          mem.all_members,
    'by_month', coalesce((
      select json_agg(r order by r.seq desc) from (
        select p.id, p.seq, p.year, p.month, p.status,
               (select full_name from members where id = p.mgr_member_id) as mgr_recipient,
               count(e.id)                                 as members,
               coalesce(sum(e.amount_paid), 0)             as collected,
               coalesce(sum(e.advance_interest_paid + e.advance_interest_deducted), 0) as interest,
               coalesce(sum(e.savings_contribution), 0)    as savings,
               coalesce(sum(e.advance_issued), 0)          as advances_issued,
               coalesce(sum(e.advance_repaid), 0)          as advances_repaid,
               p.transaction_cost                          as transaction_costs,
               p.transaction_cost_from                     as transaction_cost_from,
               coalesce(sum(e.fine_paid), 0)               as fines,
               coalesce(sum(e.mgr_contribution), 0)        as mgr_total
        from periods p left join member_entries e on e.period_id = p.id
        group by p.id
      ) r), '[]'::json)
  )
  from bal, flows, costs, bon, mem, s
$$;

-- The database functions are for the server only.
revoke execute on function start_books(integer, integer, text)                          from public, anon, authenticated;
revoke execute on function roll_period(uuid, text)                                     from public, anon, authenticated;
revoke execute on function undo_roll(text)                                             from public, anon, authenticated;
revoke execute on function issue_bonus(uuid, bigint, text, text, text, text, jsonb)    from public, anon, authenticated;
revoke execute on function void_bonus(uuid, text, text)                                from public, anon, authenticated;
revoke execute on function group_summary()                                             from public, anon, authenticated;
revoke execute on function bonus_pool_cents()                                          from public, anon, authenticated;
revoke execute on function members_with_history(integer)                               from public, anon, authenticated;
revoke execute on function set_mgr_recipient(uuid, uuid, text)                         from public, anon, authenticated;
revoke execute on function set_transaction_cost(uuid, bigint, text, text)              from public, anon, authenticated;
revoke execute on function registration_fees_left(uuid)                                from public, anon, authenticated;
revoke execute on function month_banking(uuid)                                         from public, anon, authenticated;
grant  execute on function start_books(integer, integer, text)                         to service_role;
grant  execute on function roll_period(uuid, text)                                    to service_role;
grant  execute on function undo_roll(text)                                            to service_role;
grant  execute on function issue_bonus(uuid, bigint, text, text, text, text, jsonb)   to service_role;
grant  execute on function void_bonus(uuid, text, text)                               to service_role;
grant  execute on function group_summary()                                            to service_role;
grant  execute on function bonus_pool_cents()                                         to service_role;
grant  execute on function members_with_history(integer)                              to service_role;
grant  execute on function set_mgr_recipient(uuid, uuid, text)                        to service_role;
grant  execute on function set_transaction_cost(uuid, bigint, text, text)             to service_role;
grant  execute on function registration_fees_left(uuid)                               to service_role;
grant  execute on function month_banking(uuid)                                        to service_role;

-- ---------------------------------------------------------------------
-- Table access for the server key. Newer Supabase projects no longer
-- grant this automatically to tables created in the SQL Editor.
-- The public (anon) roles get nothing.
-- ---------------------------------------------------------------------
grant usage on schema public to service_role;
grant all on table settings, app_users, members, periods, member_entries,
                   bonus_issues, bonus_allocations, audit_log to service_role;
grant usage, select on all sequences in schema public to service_role;
revoke all on table settings, app_users, members, periods, member_entries,
                    bonus_issues, bonus_allocations, audit_log from anon, authenticated;

-- make the Supabase API pick up new and changed functions straight away
notify pgrst, 'reload schema';
