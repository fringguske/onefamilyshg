# One Family Merry-Go-Round

A web app for one group that meets once a month. It keeps track of members, monthly contributions, loans, advances,
interest, savings and bonuses. It is built with Next.js (TypeScript), stores its data in Supabase (PostgreSQL), and is
hosted on Vercel.

## Features

| Page | What it does |
|---|---|
| **Group summary** | Total savings, total interest, loans and advances outstanding, cash at hand, the interest pool, bonuses, registration fees, unpaid interest, and a month-by-month table |
| **Monthly records** | *Load group records for this month*: one row per member. The chairman types the **amount brought**, **loan repaid**, **advance repaid**, **new loan** and **new advance**. The app works out the interest, the savings added and the balances carried forward |
| **Roll** | Locks the month and carries every balance into the next month. In the new month the manual fields are empty and the balances b/f and interest are already worked out |
| **Member records** | Every member with their current savings, loan balance and advance balance. Each member has a page with their month-by-month transactions |
| **Registration** | Registers a new member and records the registration fee they paid |
| **Bonus** | Shares the interest pool out to members, either by savings or equally, and either credited to savings or paid in cash. It has several safeguards (see below) |
| **Settings** | Interest rates, registration fee, opening balances, chairman accounts, undo last roll, and the audit trail (administrator only) |

## How the money is calculated

When a member brings cash, it is used in this order:

1. **Loan interest**: 10% of the loan balance b/f, plus any loan interest left unpaid from earlier months
2. **Advance interest**: 10% of the advance balance b/f, plus any advance interest left unpaid
3. **Repayments**: the loan and advance repayments the chairman types
4. **Savings**: whatever is left

* Interest is charged monthly on the balance carried into the month (reducing balance). A loan issued in January is
  first charged interest in February. The rates can be changed in Settings; a new rate applies from the next roll.
* If a member brings less than the interest due, the unpaid part is carried forward as arrears. It is not added to the
  loan, so it never earns interest itself. Repayments and savings are only possible after the interest is covered.
* Interest belongs to the group. It appears only in the Group summary. Member pages show amounts brought,
  repayments, savings and balances.

### Accuracy (no floating-point errors)

* Every amount is stored and calculated as a **whole number of cents** (`BIGINT`). Rates are stored in basis points
  (10% = 1000). Amounts typed in are parsed digit by digit, never through decimal floats.
* Interest is rounded half-up to the cent, using the same integer formula in the app and in SQL.
* The database checks every monthly record before saving it: the amount brought must equal interest + repayments +
  savings, the balances must add up, interest must be paid first, and repayments cannot exceed the balance. A record
  that breaks any of these rules is refused, even if the app has a bug.
* Bonus shares are split so they add up exactly to the total.
* Rolled months are locked by a database trigger.
* Saving the same row from two devices cannot silently overwrite the other person's figures (a version check).

### Typed figures are kept on the device

Every figure typed on the Monthly records page and the Registration form is saved to the browser's storage
(`localStorage`) as it is typed. If the chairman switches to another app, closes the tab, loses signal or the phone
reloads the page, the figures are still there when they return, marked "not saved yet". They are removed only once
they are saved to the database. The browser also warns before leaving a page with unsaved figures.

### Bonus safeguards

* A bonus can only come from interest of **rolled (locked) months**, minus bonuses already issued. A later correction
  to the open month can therefore never leave a bonus larger than the pool.
* The bonus can never be more than that pool. The database refuses it.
* The person must **preview** every member's share and type **ISSUE BONUS** to confirm. If anything changed after the
  preview, nothing is issued.
* Every bonus records who issued it. Only the **administrator** can void a bonus, and only before its month is rolled.

## Setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor > New query**, paste the whole of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**.
   It is safe to run again later.
3. From **Project Settings > API Keys**, copy the **Project URL** and the **service_role** key.

The browser never talks to Supabase directly. All tables have Row Level Security switched on with no policies, so the
public anon key can read nothing. Only the server, using the service-role key, can read and write.

### 2. Environment variables

| Variable | Value |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key. **Server only: never prefix it with `NEXT_PUBLIC_`** |
| `SESSION_SECRET` | A random string of 32+ characters: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `ADMIN_USERNAME` | Your administrator username, e.g. `admin` |
| `ADMIN_PASSWORD_HASH` | **Recommended.** Output of `npm run hash-password -- "your password"` |
| `ADMIN_PASSWORD` | Alternative to the hash (plain password). Ignored if `ADMIN_PASSWORD_HASH` is set |

As you asked, the administrator login lives only in the environment variables, not in the database. Use
`ADMIN_PASSWORD_HASH` rather than `ADMIN_PASSWORD`: then even someone who can see the Vercel settings cannot read your
password. To change your password, generate a new hash, update the variable, and redeploy.

Chairman accounts are stored in the database with scrypt-hashed passwords. The administrator creates them under
**Settings > Chairman accounts**, and each chairman can change their own password.

### 3. Deploy to Vercel

1. Push this folder to a GitHub repository.
2. On [vercel.com](https://vercel.com) choose **Add New > Project** and import the repository. Vercel detects Next.js
   automatically.
3. Add the environment variables above (Production, and Preview if you use it), then **Deploy**.

### 4. Local development

```bash
cp .env.example .env.local   # fill in the values
npm install
npm run dev                  # http://localhost:3000
npm test                     # accounting rules tests
```

## First use

1. Sign in as the administrator and create the chairman's account (**Settings**).
2. Check the interest rates and the registration fee. If the group already has money, enter the **opening cash** and
   any **interest pool brought in**.
3. **Register** all members. For a member who already has money in the group, fill in the **Opening balances**
   section of the form (savings held, loan and advance still owed).
4. Open **Monthly records** and **start the books** with the first month.
5. Feed the month, save, and **Roll** when the meeting's records are complete.

The brought-forward columns on Monthly records are never typed. In a member's first month they are the opening
balances; after that the roll fills them in. Opening balances can be corrected on the member's page until their first
month is rolled, and are locked after that.

If a month was rolled by mistake, the administrator can **Undo last roll** (Settings), as long as nothing has been fed
in the new month yet.

## Project layout

```
supabase/schema.sql        tables, constraints, roll / undo / bonus / summary functions
src/lib/ledger.ts          the accounting rules (shared by browser preview and server)
src/lib/money.ts           cents parsing/formatting
src/app/(app)/             pages
src/app/api/               server API routes (all check the login)
src/middleware.ts          redirects to /login when not signed in
tests/ledger.test.ts       tests for the rules
```
