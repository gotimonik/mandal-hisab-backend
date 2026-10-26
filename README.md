# MandalHisab — API (mandal-hisab-backend)

MandalHisab is a financial management platform for Mandals, trusts, societies and community organizations. It covers members, hapta (હપ્તો) schemes and installments, collections, donations, expenses, loans and interest, cash/bank accounts, a double-entry ledger, reports, notifications and an audit trail.

This repository is the **API**: a Next.js 16 (App Router) application that only serves REST endpoints under `/api/v1`, backed by MongoDB Atlas. The user interface lives in [`mandal-hisab-frontend`](../mandal-hisab-frontend), which calls this API from its server.

```
Browser / Capacitor app ──► mandal-hisab-frontend (Next.js, HttpOnly session cookie)
                                   │  Authorization: Bearer <session token>
                                   ▼
                            mandal-hisab-backend (this repo, /api/v1) ──► MongoDB Atlas
```

---

## Features

- **Multi-tenant organizations** – every org-scoped document carries `organizationId`; every request is checked against the caller's *active* membership in that org (`requireOrgAccess`). Unknown org and "not a member" both return 404, so org ids can't be probed.
- **Roles** – platform super-admin, organization admin, manager (with admin-configurable extra rights), member. Roles are never accepted from clients during registration or joining.
- **Organization lifecycle** – `pending → active → suspended / archived`, approved by platform admins. Pending orgs can edit settings only; archived orgs are read-only; suspended orgs are blocked.
- **Members register** – membership numbers (auto `M0001…` or custom, unique per org), search, pagination, CSV import with dry-run validation and duplicate detection (membership number / phone), member statements.
- **Hapta schemes** – weekly, every 2 weeks, monthly, every 2 months, every 3 months, FY quarterly, half-yearly, yearly, custom (days / weeks / months) and one-time; fixed or member-specific amounts; due day with month-end clamping (31st → 28/29 Feb → 31 Mar, no drift); fixed count, target amount, end date or open-ended (rolling horizon); grace days; late fees (fixed or %).
- **Installment control** – per-period scheme-wide overrides (due date / amount / skip), per-installment due date & amount changes, defer, waive, cancel, reactivate (all with reasons and history), future amount revisions that never touch paid installments, pause / resume / close, member exit. Unique `(org, enrollment, sequence)` index prevents duplicates.
- **Statuses are derived** (`upcoming, pending, partially_paid, paid, overdue, deferred, waived, cancelled`) from amounts paid by *verified* payments and dates — never from an editable status field.
- **Collections** – hapta, membership fees, event collections, other income; cash, UPI, bank transfer, cheque (configurable). Oldest-first allocation (late fee, then amount) with live preview, or explicit allocations. Pending payments do not affect balances until verified. Members can submit "I have paid" requests.
- **Receipts** – gap-free per financial year numbering (`RCPT/2026-27/000001`), one per source document, cancelled (not deleted) on reversal.
- **Donations** (with PAN for 80G), **expenses** with categories, approval thresholds, rejection reasons, out-of-pocket reimbursement, attachments (Vercel Blob).
- **Accounts & ledger** – cash/bank/UPI accounts, opening balances, transfers (asset→asset, never income), audited adjustments; balanced double-entry `ledgerEntries` for every finalized transaction; balances are always computed from the ledger.
- **Interest engine** – simple, compound, flat, reducing-balance (EMI); annual or monthly input rates; Actual/365, Actual/360, 30/360; exact BigInt rational arithmetic, rounded half-up once.
- **Loans** – application → approval → disbursement → schedule → repayments (allocation order configurable), advance payments, principal prepayment (reduce EMI or tenure), early closure quote (accrued interest to date; future interest waived), rate changes from a date (history preserved), late fees, reversal of the latest repayment, `interestCalculations` records for transparency.
- **Reports** (JSON + CSV): collections by day/month/FY-quarter/FY, hapta collection, pending & overdue, donations, event-wise, loans outstanding, interest, income & expenditure, cash flow, cash & bank summary, trial balance, balance sheet, ledger account, member statement. Exports use the same authorization as the screens.
- **Dashboards** – admin, manager and member dashboards computed with aggregation pipelines (no full-history scans).
- **Notifications** – in-app with per-user dedupe keys; reminders N days before due, on the due day and every N days overdue; payment, loan, expense and membership events. Email provider (Resend) for auth emails; push is designed to hang off `notify()`.
- **Daily job** (Vercel Cron) – extends rolling schedules, applies late fees exactly once, sends deduplicated reminders.
- **Security** – bcrypt (12 rounds), opaque 256-bit session tokens stored as HMAC hashes, session invalidation on password change / reset / deactivation, MongoDB-backed rate limiting, Zod validation everywhere, safe error messages, CORS allowlist, security headers, append-only audit log.

## Mandal savings: how the real workflow works

MandalHisab is set up for the common Mandal pattern: every member pays a fixed **monthly hapta in cash**, the Mandal credits **interest** on members' savings, and members **withdraw** cash from their balance. Amounts are per-Mandal configuration, never hard-coded — e.g. *Parivar Mandal* at ₹500/month and *College Friends Mandal* at ₹1,000/month. No payment gateway is involved; cash is recorded manually.

**1. Create the Mandal** — `POST /organizations` with `monthlyHaptaAmount` ("500"), `haptaStartMonth` (YYYY-MM), `haptaDueDay` (default 10), optional `description`. The creator becomes admin **and** a member (`creatorIsMember`, default true). A primary monthly scheme ("Monthly hapta", open-ended) is created and every active member is enrolled. You can also set it up later: `POST /orgs/:id/monthly-hapta`.
To create both example Mandals for a registered user: `SEED_ADMIN_EMAIL=you@example.com npm run seed:example` (configuration only — no fake members or money).

**2. Members join** — three ways, all producing exactly one membership per (Mandal, user) and one member record:
- *Discover & request*: `GET /organizations/search?q=parivar` (only Mandals with `settings.membership.discoverable`) or the join code → `POST /organizations/join { organizationId | code }`. Repeating a request is harmless; the admin approves/rejects in `PATCH /orgs/:id/memberships/:mid` (`approve` can take `createMember` and `haptaStartMonth`).
- *In-app invitation*: `POST /orgs/:id/invitations { email }` — an existing user sees it under `GET /invitations/mine` and accepts/declines (`POST /invitations/:id/accept|decline`). Inviting someone who is already an active member returns 409.
- *Invitation link* for people without an account: the same call returns `inviteLink`; they register and accept.
With `settings.membership.autoCreateMember` (default on) an approved/accepted user gets a member record (an unlinked record with the same email is reused) and is enrolled in the monthly hapta from the chosen month. A person can belong to both Mandals; every record is isolated by `organizationId`.

**3. Monthly hapta** — `GET /orgs/:id/monthly?month=YYYY-MM` lists one row per member for the month: expected, collected, outstanding, status (pending / partially paid / paid / overdue / waived), last payment date and who recorded it, plus members *not* enrolled that month. Quick cash entry: `POST /orgs/:id/monthly/collect { installmentId, amount, date }` — smaller amounts are part payments, overpaying is refused, and an identical amount on the same date for the same month returns `409 DUPLICATE_SUSPECTED` until `confirmDuplicate: true`. Changing the amount (`PATCH /orgs/:id/monthly-hapta { amount, effectiveMonth? }`, default next month) only affects future, unpaid months.

**4. Member balance** — each member has a savings ledger (`memberLedger`) and a cached `members.balancePaise`:

```
balance = opening + hapta paid + interest credited + other credits − withdrawals − other debits
```

`GET /orgs/:id/members/:mid/ledger` (or `/me/ledger` for the member) is a passbook with running balance; CSV with `?format=csv`. One-time opening balance: `POST …/members/:mid/opening`. Corrections: `POST …/members/:mid/adjustments { direction, amount, reason }` (audited, never edits history).

**5. Interest** — `POST /orgs/:id/interest/preview { period, mode: "rate"|"manual", monthlyRate?, basis? }` then `POST /orgs/:id/interest/runs` to finalize. Rate mode: `interest = eligible balance × monthly rate %`, rounded half-up to the paisa; the eligible balance is the member's balance at the **end of the previous month** (`previous_month_closing`, default) or only their hapta paid up to then (`hapta_contributions`). Members with ≤ 0 get nothing. The server recomputes rate-mode amounts, stores rate / basis / eligible balance per member, and refuses to credit a member twice for the same month (unique key `interest:<period>:<member>`). Interest moves **no cash**.

**6. Withdrawals** — `POST /orgs/:id/withdrawals { memberId, amount, date, note }` issues a voucher (`WDL/2026-27/000001`). It is refused if it exceeds the member's balance (checked atomically, so two simultaneous withdrawals can't overdraw) or the cash the Mandal holds. An admin may pay above the balance only when `settings.withdrawals.allowExceptions` is on and a reason is given. Mistakes are reversed (`…/withdrawals/:id/reverse`), restoring both the balance and the cash.

**7. Cash book** — `GET /orgs/:id/cashbook?from&to&accountId` shows opening cash, hapta collected, other receipts, withdrawals paid, other expenses and closing cash, line by line with a running balance, computed only from posted transactions. Other cash in/out: `POST /orgs/:id/cashbook/entries { direction: "in"|"out", amount, description }`. `GET /orgs/:id/monthly-report?month=` combines the month's hapta, interest, withdrawals, cash and every member's opening → closing balance.

**8. Upad (loans from the fund)** — a member takes upad (borrows cash) from the Mandal: `POST /orgs/:id/fund-loans { memberId, amount, date, monthlyRate? }` (default rate: `settings.fundLoans.defaultMonthlyRate`). From the month after it is given, interest is due every month on the amount still outstanding at the end of the previous month — e.g. ₹3,000 at 10% → ₹300 a month (`GET /orgs/:id/fund-loans/month?month=` lists each loan's interest for the month plus anything unpaid from earlier months). Unpaid interest carries forward (no penalty, no interest on interest). The admin records money received with `POST …/fund-loans/:loanId/payments { interestAmount, principalAmount, date }`: interest is applied oldest month first and **shared among all members' balances in proportion to their savings** (largest-remainder split, exact to the paisa), and any principal returned lowers interest from the next month. A receipt is issued. Example: 5 members × ₹1,000 = ₹5,000; ₹3,000 lent → cash ₹2,000 + lent ₹3,000; ₹300 interest paid → cash ₹2,300 + lent ₹3,000 = **₹5,300**, and each member's balance is ₹1,060. Only the latest payment on a loan can be reversed (`POST …/fund-loan-payments/:id/reverse`); a loan given by mistake can be cancelled while nothing has been paid on it. A late-recorded principal repayment can't be dated before a month whose interest was already paid on the old amount.

**9. Upad requests** — a member asks in the app: `POST /orgs/:id/me/upad-requests { amount, purpose }` (see `GET /orgs/:id/me/upad-requests` for their requests and the cash available). The amount can't exceed the cash the Mandal holds right now (all active cash / bank / UPI accounts), and a member can have only one open request (unique partial index). Admins (or managers with the withdrawals permission) see `GET /orgs/:id/upad-requests`, then `POST …/:reqId/approve { monthlyRate?, date? }` — which gives the upad with the same rules as "Give upad", re-checking the cash, and puts the request back to pending if the cash is no longer there — or `POST …/:reqId/reject { reason }` (the member sees the reason). Members can cancel their own pending request. Switch off with `settings.fundLoans.allowMemberRequests`.

**10. "I have paid"** — members report a payment and choose what it was for: *monthly hapta* (`POST /orgs/:id/me/payment-requests { purpose: "hapta" }`, applied to the oldest dues on verification), *upad* (`POST /orgs/:id/me/upad-payments { loanId, interestAmount, principalAmount }` — can't exceed the interest due / amount outstanding, counting reports still waiting), or *other* (`purpose: "other"` with a note → other income). `GET /orgs/:id/me/payment-options` pre-fills what is due. Upad reports are verified on the Upad screen (`POST /orgs/:id/upad-payments/:id/verify|reject`), which records the payment exactly like "Receive" (receipt with the member's method and reference; interest shared among members). Nothing counts until verified.

**Books behind it** (`settings.haptaTreatment = "member_savings"`, the default for new Mandals):

| Event | Debit | Credit |
|---|---|---|
| Hapta received | Cash | Member funds (liability) |
| Interest credited | Interest to members (expense) | Member funds |
| Withdrawal paid | Member funds | Cash |
| Upad given | Upad given (asset) | Cash |
| Upad interest received | Cash | Member funds (each member's share) |
| Upad amount returned | Cash | Upad given |
| Member opening balance | Opening equity | Member funds |

So Mandal cash and member balances are different numbers: cash − member balances = the Mandal's own funds (negative once interest has been credited but not yet earned). `GET /orgs/:id/member-funds/reconcile` checks Σ member ledger = Σ cached balances = general-ledger member funds. Mandals created before this feature keep `haptaTreatment = "income"` (hapta is Mandal income, as before); it can be switched only while no hapta has been collected.

## Technology

Next.js 16 (route handlers, Node runtime) · TypeScript · official MongoDB driver 7 · Zod 4 · bcryptjs · date-fns 4 · Vitest 3 + mongodb-memory-server (replica set) · ESLint 9 · @vercel/blob.

## Prerequisites

- Node.js 20.9+ (22 LTS recommended)
- A MongoDB Atlas cluster (replica set — required for multi-document transactions; every Atlas tier qualifies)

## Local setup

```bash
npm install
cp .env.example .env.local      # then fill in values (see below)
npm run db:init                 # create indexes (also done lazily on first request)
PLATFORM_ADMIN_EMAIL=you@example.com PLATFORM_ADMIN_PASSWORD='StrongPass123' npm run seed:admin
npm run dev                     # http://localhost:4000/api/v1/health
```

Then start the frontend (see its README) with `API_URL=http://localhost:4000/api/v1`.

### MongoDB Atlas configuration

1. Create a cluster (e.g. `mandal-hisab`) and a database user (e.g. `mandalhisab_app`) with **readWrite on the `mandalhisab` database only** (Database Access → Add user → Specific privileges).
2. Network Access: add your development IP. For Vercel, either allow `0.0.0.0/0` (protected by the strong user password + TLS) or use Vercel's static egress IPs / Atlas private endpoints on paid plans.
3. Copy the SRV string into `MONGODB_URI`, replacing `<db_password>` and adding the database name:
   `mongodb+srv://<db_user>:<db_password>@<cluster>.mongodb.net/mandalhisab?retryWrites=true&w=majority`
4. Never commit `.env*` files (only `.env.example`), and never put the URI in frontend or mobile code.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `MONGODB_URI` | yes | Atlas connection string (server only) |
| `MONGODB_DB` | yes | Database name, default `mandalhisab` |
| `AUTH_SECRET` | yes | ≥16 chars random secret (`openssl rand -base64 48`); keys the token hashes. Rotating it invalidates all sessions and links |
| `SESSION_TTL_DAYS` | no | Session lifetime (default 30) |
| `REQUIRE_EMAIL_VERIFICATION` | no | `true` blocks login until the email is verified |
| `APP_URL` | no | Public URL of this API |
| `FRONTEND_URL` | yes | Used in email links (verify, reset, invite) |
| `CORS_ALLOWED_ORIGINS` | no | Comma-separated origins allowed to call the API from a browser/webview (e.g. `capacitor://localhost`) |
| `ORG_REGISTRATION_POLICY` | no | `approval` (default), `open` or `disabled` |
| `PLATFORM_ADMIN_EMAIL/NAME/PASSWORD` | seed only | Used by `npm run seed:admin`; remove the password afterwards |
| `CRON_SECRET` | prod | Bearer secret Vercel Cron sends to `/api/v1/cron/daily` |
| `EMAIL_FROM`, `RESEND_API_KEY` | no | Without a key, emails are logged instead of sent |
| `BLOB_READ_WRITE_TOKEN` | no | Vercel Blob token for expense attachments; uploads are disabled without it |
| `MAX_UPLOAD_BYTES` | no | Default 5 MB |

## Scripts

| Command | |
|---|---|
| `npm run dev` / `build` / `start` | Next.js on port 4000 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Unit + integration tests (spins up an in-memory MongoDB replica set) |
| `npm run db:init` | Create indexes |
| `npm run seed:admin` | Create/promote the platform super-admin from env vars |
| `npm run seed:example` | Create *Parivar Mandal* (₹500) and *College Friends Mandal* (₹1,000) for `SEED_ADMIN_EMAIL` (idempotent, no sample money) |

## Architecture

```
src/
  app/api/v1/[...path]/route.ts   single catch-all route → Router (src/lib/http.ts)
  routes/                         endpoint tables (auth, platform, org, finance)
  services/                       business & financial logic (no HTTP)
    schedule.ts, interest.ts      pure, unit-tested calculation engines
    ledger.service.ts             double-entry posting, reversal, balances
  lib/                            db, collections+indexes, auth, permissions, money, dates, csv, audit, rate limit
  validators/                     shared Zod schemas (money → paise, dates, ids)
  types/models.ts                 TypeScript interfaces for every collection
scripts/                          init-db, seed-platform-admin
tests/unit, tests/integration     Vitest
```

Every request: CORS → route match → `ensureIndexes()` (once per cold start) → bearer auth → `requireOrgAccess(org, permission, {write})` → Zod validation → service → JSON `{ data }` or `{ error: { code, message, details } }`.

### Data model (collections)

| Collection | Purpose / key indexes |
|---|---|
| `users` | email (unique), bcrypt hash, `isPlatformAdmin`, `sessionVersion` |
| `sessions` | hashed bearer tokens, TTL on `expiresAt` |
| `authTokens` | email-verification / password-reset tokens (hashed, single-use, TTL) |
| `rateLimits` | fixed-window counters (TTL) |
| `organizations` | profile, status, embedded `settings` (FY, timezone, thresholds, manager rights, categories, methods) — `code` & `slug` unique |
| `organizationMemberships` | user ↔ org role & status, optional `memberId` link — unique `(org, user)` |
| `invitations` | email invitations (hashed token) |
| `members` | member register — unique `(org, membershipNumber)`, unique `(org, userId)` when linked |
| `haptaSchemes` | schedule definition, `amountRevisions[]`, `overrides[]` |
| `memberSchemeEnrollments` | member in scheme — unique `(org, scheme, member)` |
| `installments` | one obligation per period — unique `(org, enrollment, sequence)`; `paidPaise` maintained only inside payment transactions |
| `payments` | collections — unique `(org, idempotencyKey)` |
| `donations`, `expenses` | — unique `(org, idempotencyKey)` |
| `financialAccounts` | cash/bank/UPI — unique `(org, name)` |
| `financialTransactions` | journal headers (`TXN/2026-27/000001`), `reversalOf`/`reversedBy` |
| `ledgerEntries` | balanced debit/credit lines, indexed by `(org, accountKey, date)` |
| `receipts` | unique `(org, receiptNumber)` and `(org, sourceType, sourceId)` |
| `loans` | terms, embedded schedule (rows carry `rateApplied`), `rateHistory` |
| `loanRepayments` | split into principal/interest/penalty; snapshot for exact reversal |
| `interestCalculations` | stored calculations (schedule, closure quotes, reschedules) |
| `memberLedger` | member savings entries (opening, hapta, interest, withdrawal, adjustment) — unique partial `(org, dedupeKey)` stops double posting |
| `interestRuns` | finalized monthly interest (period, mode, rate, basis, per-member eligible balance) — unique `(org, idempotencyKey)` |
| `withdrawals` | vouchers — unique `(org, number)` and `(org, idempotencyKey)` |
| `fundLoans` | upad — loans from the Mandal fund (`UPAD/2026-27/000001`), outstanding principal, monthly rate |
| `fundLoanDues` | one interest charge per loan per month — unique `(org, loan, period)`; unpaid ones are recalculated, paid ones never change |
| `fundLoanPayments` | interest/principal received, month allocations, member shares, receipt |
| `notifications` | unique `(user, dedupeKey)` |
| `auditLogs` | append-only (actor, action, before/after, reason) |
| `counters` | per-org sequences (receipt, txn, loan, member numbers per FY) |

Relationships: `organization 1—n membership n—1 user`; `organization 1—n member`; `scheme 1—n enrollment n—1 member`; `enrollment 1—n installment`; `payment n—n installment` (via `allocations`); `payment/donation/expense/loanRepayment 1—1 financialTransaction 1—n ledgerEntry`; `payment/donation/loanRepayment 1—1 receipt`; `member 1—n loan 1—n loanRepayment`.

**Retention:** financial documents are never deleted; corrections are reversal/adjustment entries. Sessions, tokens and rate-limit buckets expire via TTL indexes. Archive organizations (status `archived`) instead of deleting them; export CSVs for off-site retention (Indian law generally expects 8 years of books of account).

## Financial rules

- **Money** is integer paise everywhere (inputs are decimal strings parsed exactly; >2 decimals rejected). Results are rounded half-up once per calculation.
- **Cash basis for contributions**: income is recognized when money is received and verified. Pending payments, pending expenses and rejected records never touch the ledger.
- **Ledger accounts**: `fa:<id>` (cash/bank/UPI, assets), `asset:loans_receivable`, `liability:reimbursements_payable`, `liability:member_funds`, `expense:member_interest`, `equity:opening_balance`, `equity:adjustments`, `income:{hapta,donation,interest,penalty,membership_fee,event,other}`, `expense:<category>`. Every transaction is validated `Σdebit = Σcredit` before writing.
- **Postings**: hapta → Dr account / Cr member funds (member-savings Mandals) or income:hapta (income Mandals) (+ income:penalty); donation → Cr income:donation; expense → Dr expense:cat / Cr account (or reimbursements payable); transfer → Dr to / Cr from; loan disbursement → Dr loans receivable / Cr account; repayment → Dr account / Cr loans receivable (principal) + income:interest + income:penalty.
- **Interest**: simple `I = P × R × days / basis`; compound `P(1 + r/m)^k − P` plus simple interest for stub days; flat = interest on original principal for the tenure spread evenly; reducing balance `EMI = P·i·(1+i)^n / ((1+i)^n − 1)`, each period's interest on the opening balance, last row absorbs rounding. Monthly input rates are converted to the nominal annual rate (×12).
- **Accrued vs charged vs paid vs outstanding**: charged = interest on rows whose due date has passed; paid = allocated from repayments; outstanding = charged − paid; accrued = closure-quote interest since the last due date (simple, day count of the loan).
- **Rate changes** recompute only unpaid future rows; each row stores the rate that applied, and `rateHistory` keeps every change.
- **Concurrency & idempotency**: all multi-document writes run in MongoDB transactions (retried automatically on transient write conflicts); every money-creating request needs an `idempotencyKey` (unique index); state transitions are conditional updates (`pending → verified` exactly once); installment updates are guarded (`paid + x ≤ amount`), and system allocations are recomputed inside the transaction, so concurrent payments can never over-allocate.

## Roles & permissions

| | Platform admin | Org admin | Manager | Member |
|---|---|---|---|---|
| Approve/suspend organizations | ✓ | | | |
| Org settings, users & roles, audit log | | ✓ | | |
| Members, installments, record collections/donations, submit expenses, basic reports | | ✓ | ✓ | |
| Verify payments | | ✓ | flag (default on) | |
| Schemes, loans create/approve, interest rates, approve expenses (≤ threshold), accounts & transfers, sensitive reports | | ✓ | flags (default off) | |
| Reverse payments, adjustments, member balance adjustments | | ✓ | | |
| Record withdrawals / credit interest | | ✓ | flags (default off) | |
| Own installments, receipts, statement, savings ledger, interest, withdrawals, loans; "I have paid" requests; request to join other Mandals | | ✓ | ✓ | ✓ |

Platform admins have **no implicit access** to an organization's private data; they only see platform-level metadata. To help an org, an org admin must invite them like any other user (which is audited).

## API overview (`/api/v1`)

Auth: `POST auth/register|login|logout|logout-all|forgot-password|reset-password|verify-email|change-password`, `GET/PATCH auth/me`.
Onboarding: `POST organizations`, `GET organizations/lookup?code=`, `GET organizations/search?q=`, `POST organizations/join`, `POST invitations/accept`, `GET invitations/mine`, `POST invitations/:id/accept|decline`.
Savings (`orgs/:orgId/…`): `monthly-hapta` (POST set up, PATCH change amount), `monthly` (+`collect`, `enroll`), `members/:id/ledger|opening|adjustments`, `me/ledger`, `me/withdrawals`, `interest/preview`, `interest/runs`, `withdrawals` (+`:id`, `:id/reverse`), `cashbook` (+`entries`), `monthly-report`, `member-funds/reconcile`, `invitations/:id/revoke`, `fund-loans` (+`month`, `:id`, `:id/payments`, `:id/cancel`), `fund-loan-payments/:id/reverse`, `me/fund-loans`, `me/upad-requests` (+`:id/cancel`), `upad-requests` (+`:id/approve|reject`).
Platform: `GET platform/stats|organizations|users`, `PATCH platform/organizations/:id`.
Org (`orgs/:orgId/…`): `memberships`, `invitations`, `members` (+`import`, `:id/statement`, `:id/allocation-preview`), `schemes` (+`enroll|exit|status|revisions|overrides|generate`), `installments`, `payments` (+`verify|reject|reverse`), `receipts`, `donations`, `expenses` (+`approve|reject|reimburse|reverse`), `accounts`, `transfers`, `adjustments`, `transactions` (+`reverse`), `loans` (+`preview|approve|reject|disburse|repayments|closure-quote|rate`), `reports/:kind?format=csv`, `dashboard`, `audit-logs`, `uploads`, `me/*` (self-service).
Cron: `GET cron/daily` (Bearer `CRON_SECRET`).

## Tests

`npm test` runs 111 tests against an in-memory MongoDB replica set, including: registration & approval, membership approval, role restrictions, **cross-organization isolation**, monthly / 2-monthly / 3-monthly / quarterly schedules, custom per-month due dates, month-end & leap years, partial/full payments, **duplicate-request idempotency**, **concurrent payments**, simple/compound/flat/reducing interest with exact paise, EMI repayments, early closure, prepayment, repayment reversal, transfers without income, expense approval/rejection, reversals & adjustments, ledger balancing, monthly/quarterly/yearly reports, trial balance & balance sheet, member statements, late-fee/reminder idempotency and cron auth — plus the Mandal savings flow (`tests/integration/savings.test.ts`): monthly installment generation and joining-month start, future-only amount changes, full/partial cash collection, overpay and duplicate guards, payment reversal, rate and manual interest with the previous-month basis and no double credit, withdrawals limited by balance and cash (including two simultaneous withdrawals), admin exceptions, reversal, opening balances and adjustments, cash book and monthly report totals, member-only visibility, manager permission flags, discovery / join requests / in-app invitations, and two Mandals for the same person staying isolated — plus loans from the fund (`tests/integration/fund-loans.test.ts`): the ₹5,000 / ₹3,000 @ 10% example end to end, carry-forward of unpaid interest, interest shared by savings, partial repayment lowering next month's interest, back-dating and over-payment guards, reversal order, member-only visibility and cancellation.

## Deploying to Vercel

1. Import the repo in Vercel (framework: Next.js). No persistent server or filesystem is needed.
2. Set the environment variables above for Production (and Preview with a separate database).
3. `vercel.json` schedules `GET /api/v1/cron/daily` at 00:30 UTC (06:00 IST); set `CRON_SECRET` so Vercel sends it.
4. After the first deploy: `npm run db:init` and `npm run seed:admin` locally against the production URI (or run once from a trusted machine).
5. Point the frontend's `API_URL` to `https://<your-api>.vercel.app/api/v1`.

## Capacitor roadmap

The API is already mobile-ready: authentication is a bearer token, so a Capacitor app can call the API directly (add `capacitor://localhost` / `https://localhost` to `CORS_ALLOWED_ORIGINS`) or load the hosted frontend in a WebView. No database credentials or server secrets ever ship in the app. Later phases: store the token in the Keychain/Keystore (`@capacitor/preferences` + secure storage plugin), deep links for verify/reset/invite URLs, push notifications by adding FCM/APNs device tokens to users and fanning out from `notify()`.

## Security notes

Secrets only in env vars; Zod on every input; rate limits on login (per IP and per email), registration, password reset, invitations and org creation; generic login errors with constant-time dummy hash checks; HMAC-hashed tokens; sessions invalidated by `sessionVersion`; tenant checks on every org route and every referenced id (accounts, members, installments are always looked up with `organizationId`); uploads validated by size, MIME type and magic bytes and stored under random paths; CSV exports neutralize spreadsheet formulas; audit log strips secrets. CSRF does not apply to this bearer-token API (no cookies); the frontend's Server Actions have Next.js's built-in origin check.

## Known limitations / next steps

- Email delivery requires a Resend key; push notifications are designed but not wired.
- PDF output is via the frontend's print-optimized pages (browser "Save as PDF") rather than server-generated PDFs.
- Loan part-prepayment is not supported for compound (bullet) loans (closure is).
- Paid installments' amounts cannot be revised automatically (by design); adjust individually if needed.
- Very large organizations (>5,000 overdue installments) should page the overdue report.
