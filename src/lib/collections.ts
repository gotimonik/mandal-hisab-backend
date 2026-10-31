import type { Collection, Db, Document } from "mongodb";
import { getDb } from "./db";
import type {
  AuditLogDoc,
  AuthTokenDoc,
  CounterDoc,
  DonationDoc,
  ExpenseDoc,
  FinancialAccountDoc,
  FinancialTransactionDoc,
  HaptaSchemeDoc,
  InstallmentDoc,
  InterestCalculationDoc,
  InterestRunDoc,
  InvitationDoc,
  LedgerEntryDoc,
  LoanDoc,
  LoanRepaymentDoc,
  MemberDoc,
  MemberLedgerEntryDoc,
  MemberSchemeEnrollmentDoc,
  NotificationDoc,
  PushDeviceDoc,
  OrganizationDoc,
  OrganizationMembershipDoc,
  PaymentDoc,
  RateLimitDoc,
  ReceiptDoc,
  SessionDoc,
  UserDoc,
  WithdrawalDoc,
  FundLoanDoc,
  FundLoanDueDoc,
  FundLoanPaymentDoc,
  UpadRequestDoc,
  UpadPaymentClaimDoc,
  MeetingDoc,
} from "@/types/models";

export interface Collections {
  users: Collection<UserDoc>;
  sessions: Collection<SessionDoc>;
  authTokens: Collection<AuthTokenDoc>;
  rateLimits: Collection<RateLimitDoc>;
  organizations: Collection<OrganizationDoc>;
  organizationMemberships: Collection<OrganizationMembershipDoc>;
  invitations: Collection<InvitationDoc>;
  members: Collection<MemberDoc>;
  haptaSchemes: Collection<HaptaSchemeDoc>;
  memberSchemeEnrollments: Collection<MemberSchemeEnrollmentDoc>;
  installments: Collection<InstallmentDoc>;
  payments: Collection<PaymentDoc>;
  donations: Collection<DonationDoc>;
  expenses: Collection<ExpenseDoc>;
  financialAccounts: Collection<FinancialAccountDoc>;
  financialTransactions: Collection<FinancialTransactionDoc>;
  ledgerEntries: Collection<LedgerEntryDoc>;
  receipts: Collection<ReceiptDoc>;
  loans: Collection<LoanDoc>;
  loanRepayments: Collection<LoanRepaymentDoc>;
  interestCalculations: Collection<InterestCalculationDoc>;
  notifications: Collection<NotificationDoc>;
  pushDevices: Collection<PushDeviceDoc>;
  auditLogs: Collection<AuditLogDoc>;
  counters: Collection<CounterDoc>;
  memberLedger: Collection<MemberLedgerEntryDoc>;
  interestRuns: Collection<InterestRunDoc>;
  withdrawals: Collection<WithdrawalDoc>;
  fundLoans: Collection<FundLoanDoc>;
  fundLoanDues: Collection<FundLoanDueDoc>;
  fundLoanPayments: Collection<FundLoanPaymentDoc>;
  upadRequests: Collection<UpadRequestDoc>;
  upadPaymentClaims: Collection<UpadPaymentClaimDoc>;
  meetings: Collection<MeetingDoc>;
}

const NAMES: (keyof Collections)[] = [
  "users",
  "sessions",
  "authTokens",
  "rateLimits",
  "organizations",
  "organizationMemberships",
  "invitations",
  "members",
  "haptaSchemes",
  "memberSchemeEnrollments",
  "installments",
  "payments",
  "donations",
  "expenses",
  "financialAccounts",
  "financialTransactions",
  "ledgerEntries",
  "receipts",
  "loans",
  "loanRepayments",
  "interestCalculations",
  "notifications",
  "pushDevices",
  "auditLogs",
  "counters",
  "memberLedger",
  "interestRuns",
  "withdrawals",
  "fundLoans",
  "fundLoanDues",
  "fundLoanPayments",
  "upadRequests",
  "upadPaymentClaims",
  "meetings",
];

export function collectionsFor(db: Db): Collections {
  const out = {} as Record<string, Collection<Document>>;
  for (const n of NAMES) out[n] = db.collection(n);
  return out as unknown as Collections;
}

export async function cols(): Promise<Collections> {
  return collectionsFor(await getDb());
}

let indexesEnsured: Promise<void> | null = null;

/**
 * Create all indexes (idempotent). Called by `npm run db:init`, by tests, and lazily
 * once per cold start by the API so a fresh database is always safe to use.
 */
export function ensureIndexes(): Promise<void> {
  if (!indexesEnsured) {
    indexesEnsured = createIndexes().catch((e) => {
      indexesEnsured = null;
      throw e;
    });
  }
  return indexesEnsured;
}

export function resetIndexCache() {
  indexesEnsured = null;
}

async function createIndexes() {
  const c = await cols();
  await Promise.all([
    c.users.createIndex({ email: 1 }, { unique: true }),
    c.sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    c.sessions.createIndex({ userId: 1 }),
    c.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.authTokens.createIndex({ tokenHash: 1 }, { unique: true }),
    c.authTokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.rateLimits.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),

    c.organizations.createIndex({ code: 1 }, { unique: true }),
    c.organizations.createIndex({ slug: 1 }, { unique: true }),
    c.organizations.createIndex({ status: 1, createdAt: -1 }),
    c.organizationMemberships.createIndex({ organizationId: 1, userId: 1 }, { unique: true }),
    c.organizationMemberships.createIndex({ userId: 1, status: 1 }),
    c.organizationMemberships.createIndex({ organizationId: 1, status: 1, role: 1 }),
    c.invitations.createIndex({ tokenHash: 1 }, { unique: true }),
    c.invitations.createIndex({ organizationId: 1, email: 1, status: 1 }),

    c.members.createIndex({ organizationId: 1, membershipNumber: 1 }, { unique: true }),
    c.members.createIndex({ organizationId: 1, status: 1, name: 1 }),
    c.members.createIndex({ organizationId: 1, searchText: 1 }),
    c.members.createIndex(
      { organizationId: 1, userId: 1 },
      { unique: true, partialFilterExpression: { userId: { $type: "objectId" } } },
    ),

    c.haptaSchemes.createIndex({ organizationId: 1, status: 1, createdAt: -1 }),
    c.memberSchemeEnrollments.createIndex({ organizationId: 1, schemeId: 1, memberId: 1 }, { unique: true }),
    c.memberSchemeEnrollments.createIndex({ organizationId: 1, memberId: 1 }),
    c.installments.createIndex({ organizationId: 1, enrollmentId: 1, sequence: 1 }, { unique: true }),
    c.installments.createIndex({ organizationId: 1, memberId: 1, dueDate: 1 }),
    c.installments.createIndex({ organizationId: 1, schemeId: 1, dueDate: 1 }),
    c.installments.createIndex({ organizationId: 1, state: 1, dueDate: 1 }),

    c.payments.createIndex({ organizationId: 1, idempotencyKey: 1 }, { unique: true }),
    c.payments.createIndex({ organizationId: 1, status: 1, date: -1 }),
    c.payments.createIndex({ organizationId: 1, memberId: 1, date: -1 }),
    c.donations.createIndex({ organizationId: 1, idempotencyKey: 1 }, { unique: true }),
    c.donations.createIndex({ organizationId: 1, status: 1, date: -1 }),
    c.expenses.createIndex({ organizationId: 1, idempotencyKey: 1 }, { unique: true }),
    c.expenses.createIndex({ organizationId: 1, status: 1, date: -1 }),

    c.financialAccounts.createIndex({ organizationId: 1, name: 1 }, { unique: true }),
    c.financialTransactions.createIndex({ organizationId: 1, number: 1 }, { unique: true }),
    c.financialTransactions.createIndex({ organizationId: 1, date: -1, _id: -1 }),
    c.financialTransactions.createIndex({ organizationId: 1, sourceType: 1, sourceId: 1 }),
    c.financialTransactions.createIndex(
      { organizationId: 1, idempotencyKey: 1 },
      { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
    ),
    c.ledgerEntries.createIndex({ organizationId: 1, accountKey: 1, date: 1 }),
    c.ledgerEntries.createIndex({ organizationId: 1, date: 1 }),
    c.ledgerEntries.createIndex({ organizationId: 1, transactionId: 1 }),
    c.ledgerEntries.createIndex({ organizationId: 1, memberId: 1, date: 1 }),
    c.receipts.createIndex({ organizationId: 1, receiptNumber: 1 }, { unique: true }),
    c.receipts.createIndex({ organizationId: 1, sourceType: 1, sourceId: 1 }, { unique: true }),
    c.receipts.createIndex({ organizationId: 1, memberId: 1, date: -1 }),

    c.loans.createIndex({ organizationId: 1, loanNumber: 1 }, { unique: true }),
    c.loans.createIndex({ organizationId: 1, status: 1 }),
    c.loans.createIndex({ organizationId: 1, memberId: 1 }),
    c.loanRepayments.createIndex({ organizationId: 1, idempotencyKey: 1 }, { unique: true }),
    c.loanRepayments.createIndex({ organizationId: 1, loanId: 1, date: 1 }),
    c.interestCalculations.createIndex({ organizationId: 1, subjectType: 1, subjectId: 1, createdAt: -1 }),

    c.notifications.createIndex({ userId: 1, dedupeKey: 1 }, { unique: true }),
    c.notifications.createIndex({ userId: 1, organizationId: 1, createdAt: -1 }),
    c.pushDevices.createIndex({ token: 1 }, { unique: true }),
    c.pushDevices.createIndex({ userId: 1 }),
    c.auditLogs.createIndex({ organizationId: 1, createdAt: -1 }),

    // Member savings ledger: dedupeKey makes double interest / double posting impossible.
    c.memberLedger.createIndex(
      { organizationId: 1, dedupeKey: 1 },
      { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } },
    ),
    c.memberLedger.createIndex({ organizationId: 1, memberId: 1, date: 1, _id: 1 }),
    c.memberLedger.createIndex({ organizationId: 1, kind: 1, period: 1 }),
    c.memberLedger.createIndex({ organizationId: 1, sourceType: 1, sourceId: 1 }),
    c.interestRuns.createIndex({ organizationId: 1, idempotencyKey: 1 }, { unique: true }),
    c.interestRuns.createIndex({ organizationId: 1, period: -1 }),
    c.withdrawals.createIndex({ organizationId: 1, idempotencyKey: 1 }, { unique: true }),
    c.withdrawals.createIndex({ organizationId: 1, number: 1 }, { unique: true }),
    c.withdrawals.createIndex({ organizationId: 1, memberId: 1, date: -1 }),
    c.withdrawals.createIndex({ organizationId: 1, date: -1 }),
    c.fundLoans.createIndex({ organizationId: 1, idempotencyKey: 1 }, { unique: true }),
    c.fundLoans.createIndex({ organizationId: 1, number: 1 }, { unique: true }),
    c.fundLoans.createIndex({ organizationId: 1, status: 1, memberId: 1 }),
    c.fundLoanDues.createIndex({ organizationId: 1, loanId: 1, period: 1 }, { unique: true }),
    c.fundLoanDues.createIndex({ organizationId: 1, period: 1 }),
    c.fundLoanDues.createIndex({ organizationId: 1, memberId: 1, period: 1 }),
    c.fundLoanPayments.createIndex({ organizationId: 1, idempotencyKey: 1 }, { unique: true }),
    c.fundLoanPayments.createIndex({ organizationId: 1, loanId: 1, date: -1 }),
    c.upadRequests.createIndex({ organizationId: 1, idempotencyKey: 1 }, { unique: true }),
    // one open request per member at a time
    c.upadRequests.createIndex({ organizationId: 1, memberId: 1 }, { unique: true, partialFilterExpression: { status: "pending" }, name: "one_pending_upad_request" }),
    c.upadRequests.createIndex({ organizationId: 1, status: 1, createdAt: -1 }),
    c.upadPaymentClaims.createIndex({ organizationId: 1, idempotencyKey: 1 }, { unique: true }),
    c.upadPaymentClaims.createIndex({ organizationId: 1, status: 1, createdAt: -1 }),
    c.upadPaymentClaims.createIndex({ organizationId: 1, memberId: 1, createdAt: -1 }),
    c.meetings.createIndex({ organizationId: 1, idempotencyKey: 1 }, { unique: true }),
    c.meetings.createIndex({ organizationId: 1, date: 1, time: 1 }),
    c.haptaSchemes.createIndex(
      { organizationId: 1, isPrimary: 1 },
      { unique: true, partialFilterExpression: { isPrimary: true } },
    ),
    c.auditLogs.createIndex({ organizationId: 1, entityType: 1, entityId: 1 }),
  ]);
}
