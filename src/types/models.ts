/**
 * Core MongoDB document shapes for MandalHisab.
 *
 * Conventions
 * - All money is stored as integer paise (`...Paise`, a JS safe integer). Never floats.
 * - Calendar dates without a time (due dates, transaction dates) are stored as a Date at
 *   00:00:00.000 UTC representing that calendar day in the organization's timezone.
 * - Every organization-specific document carries `organizationId` (tenant isolation).
 * - Financial history is append-only: corrections are reversal/adjustment documents.
 */
import type { ObjectId } from "mongodb";

export type Id = ObjectId;

interface Timestamps {
  createdAt: Date;
  updatedAt: Date;
}

/* ------------------------------------------------------------------ Users / auth */

export interface UserDoc extends Timestamps {
  _id: Id;
  name: string;
  email: string; // lower-cased, unique
  phone?: string;
  passwordHash: string;
  emailVerifiedAt?: Date | null;
  isPlatformAdmin: boolean;
  status: "active" | "deactivated";
  lastLoginAt?: Date;
  /** Bumped on password change / deactivation; sessions issued before are invalid. */
  sessionVersion: number;
}

export interface SessionDoc {
  _id: Id;
  userId: Id;
  tokenHash: string; // sha256 of the opaque bearer token
  sessionVersion: number;
  createdAt: Date;
  expiresAt: Date; // TTL index
  lastUsedAt: Date;
  userAgent?: string;
  ip?: string;
}

export interface AuthTokenDoc {
  _id: Id;
  userId: Id;
  purpose: "email_verification" | "password_reset";
  tokenHash: string;
  expiresAt: Date; // TTL index
  usedAt?: Date | null;
  createdAt: Date;
}

export interface RateLimitDoc {
  _id: string; // bucket key
  count: number;
  expiresAt: Date; // TTL index
}

/* ------------------------------------------------------------------ Organizations */

export type OrgStatus = "pending" | "active" | "suspended" | "archived";

export interface ManagerPermissionFlags {
  canCreateLoans: boolean;
  canApproveLoans: boolean;
  canModifyInterest: boolean;
  canApproveExpenses: boolean;
  canVerifyPayments: boolean;
  canManageSchemes: boolean;
  canAccessSensitiveReports: boolean;
  canManageAccounts: boolean;
  canRecordWithdrawals: boolean;
  canDistributeInterest: boolean;
}

export interface ExpenseCategory {
  key: string; // slug, used in ledger account key expense:<key>
  name: string;
  isActive: boolean;
}

export interface OrganizationSettings {
  financialYearStartMonth: number; // 1-12 (India: 4 = April)
  /** ISO 4217 code (2-decimal currencies only, see lib/currency.ts). Default INR. */
  currency: string;
  timezone: string; // IANA, default Asia/Kolkata
  receiptPrefix: string;
  requirePaymentVerification: boolean; // payments recorded by managers stay pending until verified
  expenseApprovalThresholdPaise: number; // expenses above this need approval; 0 = always
  reminderDaysBefore: number[]; // e.g. [3, 0]
  overdueReminderEveryDays: number; // 0 = disabled
  managerPermissions: ManagerPermissionFlags;
  expenseCategories: ExpenseCategory[];
  paymentMethods: string[]; // cash, bank_transfer, upi, cheque, ...
  installmentHorizonMonths: number; // how far ahead open-ended schemes are generated
  /** The Mandal's main monthly hapta (backed by a primary scheme). Absent until set up. */
  monthlyHapta?: MonthlyHaptaSettings | null;
  /**
   * How hapta is treated in the books:
   *  - member_savings: contributions belong to members (credited to their balance; liability
   *    "member funds"); interest credited to members is a Mandal expense; withdrawals pay it out.
   *  - income: contributions are Mandal income (classic Mandal/festival fund).
   */
  haptaTreatment: "member_savings" | "income";
  interest: InterestSettings;
  withdrawals: { allowExceptions: boolean };
  /** Loans from the Mandal fund: interest-only, charged monthly on the outstanding amount. */
  fundLoans: { defaultMonthlyRate: string; dueDay: number; allowMemberRequests: boolean };
  membership: { discoverable: boolean; allowJoinRequests: boolean; autoCreateMember: boolean };
  /** Last month the Mandal runs (YYYY-MM). No hapta is created after it. Absent/null = no end. */
  endMonth?: string | null;
  /** Closing & settlement progress (see settlement.service). */
  settlement?: SettlementState | null;
}

export interface SettlementState {
  startedAt: Date;
  startedBy: Id;
  /** each "share out the Mandal's own money" step */
  distributions: { at: Date; totalPaise: number; transactionId: Id | null; perShare: number; shares: number }[];
  payouts: { memberId: Id; at: Date; netPaise: number; grossPaise: number; upadSettledPaise: number; withdrawalId: Id | null }[];
  closedAt?: Date | null;
}

export interface MonthlyHaptaSettings {
  schemeId: Id;
  amountPaise: number;
  dueDay: number;
  startDate: Date; // first day of the first hapta month
}

export interface InterestSettings {
  defaultMode: "manual" | "rate";
  /** Monthly rate as a decimal percent string, e.g. "1" = 1% per month */
  monthlyRate: string;
  /**
   * Rate-based eligible balance:
   *  - previous_month_closing: member balance at the end of the previous month (default)
   *  - hapta_contributions: total hapta contributed up to the end of the previous month
   */
  basis: "previous_month_closing" | "hapta_contributions";
}

export interface OrganizationDoc extends Timestamps {
  _id: Id;
  name: string;
  code: string; // unique short join code
  slug: string;
  logoUrl?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  contactPhone?: string;
  contactEmail?: string;
  registrationNumber?: string;
  registrationDetails?: string;
  description?: string;
  status: OrgStatus;
  statusReason?: string;
  createdBy: Id;
  settings: OrganizationSettings;
}

export type OrgRole = "admin" | "manager" | "member";

export interface OrganizationMembershipDoc extends Timestamps {
  _id: Id;
  organizationId: Id;
  userId: Id;
  role: OrgRole;
  status: "pending" | "active" | "rejected" | "deactivated";
  /** Link to the member register entry representing this user (for self-service). */
  memberId?: Id | null;
  requestMessage?: string;
  approvedBy?: Id;
  approvedAt?: Date;
}

export interface InvitationDoc extends Timestamps {
  _id: Id;
  organizationId: Id;
  email: string;
  role: OrgRole;
  memberId?: Id | null;
  tokenHash: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  invitedBy: Id;
  expiresAt: Date;
}

/* ------------------------------------------------------------------ Members */

export interface MemberDoc extends Timestamps {
  _id: Id;
  organizationId: Id;
  membershipNumber: string; // unique per org
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  joiningDate: Date;
  status: "active" | "inactive" | "left";
  userId?: Id | null;
  notes?: string;
  /** How many haptas this member pays each month (e.g. 3 × ₹500). Default 1. */
  haptaShares?: number;
  searchText: string; // lower-cased name/number/phone for search
  /**
   * Cached member balance (paise) = Σ memberLedger credits − debits. Maintained ONLY by
   * postMemberEntry() inside transactions; used as a concurrency guard for withdrawals.
   */
  balancePaise?: number;
}

/* ------------------------------------------------------------------ Member ledger (savings) */

export type MemberEntryKind =
  | "opening"
  | "hapta"
  | "interest"
  | "withdrawal"
  | "adjustment"
  | "reversal";

export interface MemberLedgerEntryDoc {
  _id: Id;
  organizationId: Id;
  memberId: Id;
  date: Date;
  kind: MemberEntryKind;
  creditPaise: number;
  debitPaise: number;
  description: string;
  /** e.g. "2026-10" for hapta/interest */
  period?: string;
  sourceType: "payment" | "interestRun" | "withdrawal" | "opening" | "adjustment" | "fundLoanPayment" | "settlement";
  sourceId: Id;
  transactionId?: Id | null;
  /** Unique per org when set: prevents double interest / double opening balance / double posting */
  dedupeKey?: string;
  reversalOf?: Id | null;
  createdBy: Id;
  createdAt: Date;
}

export interface InterestRunDoc {
  _id: Id;
  organizationId: Id;
  period: string; // YYYY-MM
  mode: "manual" | "rate";
  monthlyRate?: string | null;
  basis?: InterestSettings["basis"] | null;
  basisDate?: Date | null; // eligible balance measured at end of this date
  creditDate: Date;
  entries: { memberId: Id; eligibleBalancePaise: number | null; interestPaise: number; ledgerEntryId: Id }[];
  totalPaise: number;
  status: "finalized";
  transactionId: Id;
  idempotencyKey: string;
  note?: string;
  createdBy: Id;
  createdAt: Date;
}

export interface WithdrawalDoc {
  _id: Id;
  organizationId: Id;
  number: string; // WDL/2026-27/000001
  memberId: Id;
  amountPaise: number;
  date: Date;
  accountId: Id;
  note?: string;
  balanceBeforePaise: number;
  balanceAfterPaise: number;
  exceptionReason?: string | null;
  status: "paid" | "reversed";
  idempotencyKey: string;
  transactionId: Id;
  ledgerEntryId: Id;
  reversalReason?: string;
  reversalTransactionId?: Id;
  recordedBy: Id;
  createdAt: Date;
}

/* ------------------------------------------------------------------ Hapta schemes */

export type Frequency =
  | "weekly"
  | "biweekly"
  | "monthly"
  | "bimonthly"
  | "every_three_months"
  | "quarterly"
  | "half_yearly"
  | "yearly"
  | "custom"
  | "one_time";

export interface CustomInterval {
  unit: "day" | "week" | "month";
  count: number;
}

export interface LateFeeRule {
  enabled: boolean;
  type: "fixed" | "percent";
  /** fixed: paise; percent: basis points of installment amount (100 = 1%) */
  value: number;
  graceDays: number;
}

export interface SchemeOverride {
  sequence: number;
  dueDate?: Date;
  amountPaise?: number;
  skip?: boolean;
  reason: string;
  createdBy: Id;
  createdAt: Date;
}

export interface AmountRevision {
  effectiveFrom: Date; // applies to installments due on/after this date
  amountPaise: number;
  reason?: string;
  createdBy: Id;
  createdAt: Date;
}

export interface HaptaSchemeDoc extends Timestamps {
  _id: Id;
  organizationId: Id;
  /** The Mandal's main monthly hapta scheme (driven by settings.monthlyHapta) */
  isPrimary?: boolean;
  name: string;
  description?: string;
  startDate: Date;
  endDate?: Date | null;
  frequency: Frequency;
  customInterval?: CustomInterval | null;
  dueDay?: number | null; // 1-31 for month-based frequencies (clamped to month end)
  amountPaise: number; // default per-installment amount
  amountMode: "fixed" | "member_specific";
  numberOfInstallments?: number | null;
  targetAmountPaise?: number | null;
  graceDays: number;
  lateFee: LateFeeRule;
  status: "draft" | "active" | "paused" | "closed";
  pausedAt?: Date | null;
  amountRevisions: AmountRevision[];
  overrides: SchemeOverride[];
  notes?: string;
  attachments?: AttachmentRef[];
  createdBy: Id;
}

export interface MemberSchemeEnrollmentDoc extends Timestamps {
  _id: Id;
  organizationId: Id;
  schemeId: Id;
  memberId: Id;
  amountPaise?: number | null; // member-specific override
  /** hapta shares: each installment is the amount × shares (default 1) */
  shares?: number;
  startDate: Date;
  status: "active" | "exited";
  generatedUpTo?: Date | null;
  lastSequence: number;
}

export type InstallmentState = "active" | "deferred" | "waived" | "cancelled";
export type InstallmentStatus =
  | "upcoming"
  | "pending"
  | "partially_paid"
  | "paid"
  | "overdue"
  | "deferred"
  | "waived"
  | "cancelled";

export interface InstallmentDoc extends Timestamps {
  _id: Id;
  organizationId: Id;
  schemeId: Id;
  enrollmentId: Id;
  memberId: Id;
  sequence: number; // unique per enrollment
  periodLabel: string;
  dueDate: Date;
  amountPaise: number;
  penaltyPaise: number;
  /** Derived cache maintained ONLY by verified payment allocation / reversal inside transactions. */
  paidPaise: number;
  penaltyPaidPaise: number;
  state: InstallmentState;
  stateReason?: string;
  amountSource: "scheme" | "member" | "override" | "revision";
  /** hapta shares this installment was generated for (amountPaise already includes them). Default 1. */
  shares?: number;
  history: { at: Date; by: Id; action: string; from?: unknown; to?: unknown; reason?: string }[];
}

/* ------------------------------------------------------------------ Money movement */

export type PaymentMethod = string; // validated against org settings

export type PaymentKind = "hapta" | "membership_fee" | "event" | "other_income";

export interface PaymentAllocation {
  installmentId: Id;
  amountPaise: number; // towards installment amount
  penaltyPaise: number; // towards late fee
}

export interface AttachmentRef {
  url: string;
  name: string;
  contentType: string;
  size: number;
}

export interface PaymentDoc extends Timestamps {
  _id: Id;
  organizationId: Id;
  kind: PaymentKind;
  memberId?: Id | null;
  payerName?: string;
  amountPaise: number;
  date: Date;
  method: PaymentMethod;
  reference?: string;
  /** Financial account receiving money. May be empty on a member's request until verified. */
  accountId?: Id | null;
  schemeId?: Id | null;
  allocations: PaymentAllocation[];
  /** true when allocations were computed by the system (recomputed at verification) */
  autoAllocated: boolean;
  eventName?: string;
  notes?: string;
  attachments?: AttachmentRef[];
  status: "pending" | "verified" | "rejected" | "reversed";
  source: "staff" | "member_request";
  idempotencyKey: string;
  recordedBy: Id;
  verifiedBy?: Id;
  verifiedAt?: Date;
  rejectedReason?: string;
  transactionId?: Id;
  reversalTransactionId?: Id;
  reversalReason?: string;
  receiptId?: Id;
}

export interface DonationDoc extends Timestamps {
  _id: Id;
  organizationId: Id;
  donorName: string;
  memberId?: Id | null;
  donorPhone?: string;
  donorPan?: string;
  amountPaise: number;
  date: Date;
  method: string;
  reference?: string;
  accountId: Id;
  purpose?: string;
  eventName?: string;
  notes?: string;
  status: "pending" | "verified" | "rejected" | "reversed";
  idempotencyKey: string;
  recordedBy: Id;
  verifiedBy?: Id;
  verifiedAt?: Date;
  transactionId?: Id;
  reversalTransactionId?: Id;
  reversalReason?: string;
  receiptId?: Id;
}

export interface ExpenseDoc extends Timestamps {
  _id: Id;
  organizationId: Id;
  categoryKey: string;
  payeeName: string;
  description: string;
  amountPaise: number;
  date: Date;
  method: string;
  reference?: string;
  /** Account the money left from. Null when paid out of pocket (reimbursable). */
  accountId?: Id | null;
  paidBy: "organization" | "out_of_pocket";
  reimburseToMemberId?: Id | null;
  reimbursement?: { status: "pending" | "reimbursed"; transactionId?: Id; accountId?: Id; at?: Date };
  eventName?: string;
  attachments?: AttachmentRef[];
  status: "pending" | "approved" | "rejected" | "reversed";
  idempotencyKey: string;
  submittedBy: Id;
  approvedBy?: Id;
  approvedAt?: Date;
  rejectedBy?: Id;
  rejectionReason?: string;
  transactionId?: Id;
  reversalTransactionId?: Id;
  reversalReason?: string;
}

export interface FinancialAccountDoc extends Timestamps {
  _id: Id;
  organizationId: Id;
  name: string;
  type: "cash" | "bank" | "upi" | "other";
  bankName?: string;
  accountNumberLast4?: string;
  ifsc?: string;
  upiId?: string;
  openingBalancePaise: number;
  openingDate: Date;
  isActive: boolean;
  createdBy: Id;
}

export type TransactionType =
  | "opening_balance"
  | "hapta_collection"
  | "other_income"
  | "donation"
  | "expense"
  | "expense_reimbursement"
  | "transfer"
  | "loan_disbursement"
  | "loan_repayment"
  | "adjustment"
  | "reversal"
  | "interest_credit"
  | "withdrawal"
  | "member_opening"
  | "member_adjustment"
  | "fund_loan_given"
  | "fund_loan_payment"
  | "closing_distribution";

export interface FinancialTransactionDoc {
  _id: Id;
  organizationId: Id;
  number: string; // TXN/2026-27/000001
  type: TransactionType;
  date: Date;
  amountPaise: number; // total debits (== total credits)
  description: string;
  memberId?: Id | null;
  eventName?: string;
  sourceType?: "payment" | "donation" | "expense" | "loan" | "loanRepayment" | "transfer" | "account" | "adjustment" | "interestRun" | "withdrawal" | "memberOpening" | "memberAdjustment" | "cashEntry" | "fundLoan" | "fundLoanPayment" | "settlement";
  sourceId?: Id;
  reversalOf?: Id | null;
  reversedBy?: Id | null;
  reason?: string;
  /** Client-supplied key for directly-posted entries (transfers, adjustments) */
  idempotencyKey?: string;
  createdBy: Id;
  createdAt: Date;
}

export interface LedgerEntryDoc {
  _id: Id;
  organizationId: Id;
  transactionId: Id;
  date: Date;
  accountKey: string; // fa:<id> | income:hapta | expense:<cat> | asset:loans_receivable | ...
  financialAccountId?: Id | null;
  debitPaise: number;
  creditPaise: number;
  memberId?: Id | null;
  transactionType: TransactionType;
  /** For reversal entries: the type of the transaction being reversed (lets reports net it) */
  originalType?: TransactionType;
  createdAt: Date;
}

export interface ReceiptDoc {
  _id: Id;
  organizationId: Id;
  receiptNumber: string;
  sourceType: "payment" | "donation" | "loanRepayment" | "withdrawal" | "fundLoanPayment";
  sourceId: Id;
  memberId?: Id | null;
  payerName: string;
  amountPaise: number;
  date: Date;
  method: string;
  reference?: string;
  lines: { description: string; amountPaise: number }[];
  issuedBy: Id;
  issuedAt: Date;
  status: "valid" | "cancelled";
}

/* ------------------------------------------------------------------ Loans */

export type InterestMethod = "simple" | "compound" | "flat" | "reducing_balance";

export interface LoanScheduleRow {
  sequence: number;
  dueDate: Date;
  openingPrincipalPaise: number;
  principalDuePaise: number;
  interestDuePaise: number;
  totalDuePaise: number;
  principalPaidPaise: number;
  interestPaidPaise: number;
  penaltyPaise: number;
  penaltyPaidPaise: number;
  status: "upcoming" | "due" | "partially_paid" | "paid" | "overdue" | "waived";
  /** Annual rate used to compute this row's interest */
  rateApplied: string;
}

export interface LoanDoc extends Timestamps {
  _id: Id;
  organizationId: Id;
  loanNumber: string;
  memberId: Id;
  purpose?: string;
  requestedPaise: number;
  approvedPaise?: number | null;
  principalPaise?: number | null; // disbursed
  interestMethod: InterestMethod;
  /** Annual nominal rate as a decimal string, e.g. "12" or "10.5" */
  annualRate: string;
  rateInput: { value: string; period: "annual" | "monthly" };
  compoundingPerYear?: number | null;
  dayCount: "actual_365" | "actual_360" | "30_360";
  tenure: number; // number of repayments
  repaymentFrequency: "weekly" | "biweekly" | "monthly" | "quarterly";
  firstDueDate?: Date | null;
  disbursedOn?: Date | null;
  disbursementAccountId?: Id | null;
  graceDays: number;
  lateFee: LateFeeRule;
  allocationOrder: ("penalty" | "interest" | "principal")[];
  prepaymentMode: "reduce_tenure" | "reduce_emi";
  status: "applied" | "approved" | "rejected" | "active" | "closed";
  /** Every rate that has applied to this loan; historical periods keep their rate. */
  rateHistory: { annualRate: string; effectiveFrom: Date; setBy: Id; at: Date; reason?: string }[];
  schedule: LoanScheduleRow[];
  outstandingPrincipalPaise: number;
  totalInterestPaidPaise: number;
  totalPenaltyPaidPaise: number;
  totalPrincipalPaidPaise: number;
  rejectionReason?: string;
  appliedBy: Id;
  approvedBy?: Id;
  approvedAt?: Date;
  disbursedBy?: Id;
  closedAt?: Date;
  disbursementTransactionId?: Id;
  notes?: string;
}

export interface LoanRepaymentDoc {
  _id: Id;
  organizationId: Id;
  loanId: Id;
  memberId: Id;
  amountPaise: number;
  principalPaise: number;
  interestPaise: number;
  penaltyPaise: number;
  date: Date;
  method: string;
  reference?: string;
  accountId: Id;
  kind: "installment" | "prepayment" | "closure";
  allocations: { sequence: number; principalPaise: number; interestPaise: number; penaltyPaise: number }[];
  idempotencyKey: string;
  status: "verified" | "reversed";
  transactionId: Id;
  receiptId?: Id;
  recordedBy: Id;
  createdAt: Date;
}

export interface InterestCalculationDoc {
  _id: Id;
  organizationId: Id;
  subjectType: "loan" | "scheme";
  subjectId: Id;
  method: InterestMethod;
  annualRate: string;
  principalPaise: number;
  periodStart: Date;
  periodEnd: Date;
  days?: number;
  periods?: number;
  dayCount?: string;
  compoundingPerYear?: number | null;
  interestPaise: number;
  purpose: "schedule" | "closure_quote" | "accrual" | "prepayment_reschedule";
  details?: Record<string, unknown>;
  createdBy?: Id;
  createdAt: Date;
}

/* ------------------------------------------------------------------ Misc */

export interface NotificationDoc {
  _id: Id;
  organizationId: Id;
  userId: Id;
  type: string;
  title: string;
  body: string;
  link?: string;
  dedupeKey: string; // unique per (userId, dedupeKey)
  readAt?: Date | null;
  createdAt: Date;
}

export interface AuditLogDoc {
  _id: Id;
  organizationId?: Id | null;
  actorId?: Id | null;
  action: string;
  entityType: string;
  entityId?: Id | string | null;
  before?: unknown;
  after?: unknown;
  reason?: string;
  ip?: string;
  createdAt: Date;
}

export interface CounterDoc {
  _id: string; // `${orgId}:${name}`
  seq: number;
}

/* ------------------------------------------------------------------ Loans from the Mandal fund */

/**
 * A member borrows cash from the Mandal fund. Each month from the month after it is given,
 * interest is due on the amount still outstanding at the end of the previous month.
 * Unpaid interest simply carries forward (no penalty, no interest on interest).
 * The principal can be returned in part or in full at any time.
 */
export interface FundLoanDoc {
  _id: Id;
  organizationId: Id;
  number: string; // UPAD/2026-27/000001
  memberId: Id;
  principalPaise: number; // amount given
  outstandingPaise: number; // principal still to be returned
  monthlyRate: string; // % per month, e.g. "10"
  date: Date; // given on
  firstInterestMonth: string; // YYYY-MM (month after `date`)
  accountId: Id;
  note?: string;
  status: "active" | "closed" | "cancelled";
  closedAt?: Date | null;
  cancelReason?: string;
  idempotencyKey: string;
  transactionId: Id;
  createdBy: Id;
  createdAt: Date;
  updatedAt: Date;
}

/** One month's interest charge on a fund loan — unique (org, loan, period). */
export interface FundLoanDueDoc {
  _id: Id;
  organizationId: Id;
  loanId: Id;
  memberId: Id;
  period: string; // YYYY-MM
  dueDate: Date;
  principalBasisPaise: number; // outstanding at the end of the previous month
  monthlyRate: string;
  interestPaise: number;
  paidPaise: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface FundLoanPaymentDoc {
  _id: Id;
  organizationId: Id;
  loanId: Id;
  memberId: Id;
  date: Date;
  interestPaise: number;
  principalPaise: number;
  /** how the interest part was applied, oldest month first */
  allocations: { dueId: Id; period: string; amountPaise: number }[];
  /** how the interest was shared among members */
  shares: { memberId: Id; amountPaise: number; ledgerEntryId: Id }[];
  accountId: Id;
  note?: string;
  status: "valid" | "reversed";
  reversalReason?: string;
  reversalTransactionId?: Id;
  receiptId: Id;
  transactionId: Id;
  idempotencyKey: string;
  recordedBy: Id;
  createdAt: Date;
}

/** A member's request for upad, approved (→ a FundLoanDoc) or rejected by an admin. */
export interface UpadRequestDoc {
  _id: Id;
  organizationId: Id;
  memberId: Id;
  requestedBy: Id; // user
  amountPaise: number;
  purpose?: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  /** Mandal cash available when the request was made (shown to the admin) */
  availableAtRequestPaise: number;
  decisionReason?: string;
  decidedBy?: Id | null;
  decidedAt?: Date | null;
  loanId?: Id | null;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A member reports paying upad interest / returning upad; an admin verifies (→ FundLoanPaymentDoc) or rejects. */
export interface UpadPaymentClaimDoc {
  _id: Id;
  organizationId: Id;
  memberId: Id;
  loanId: Id;
  interestPaise: number;
  principalPaise: number;
  date: Date;
  method: string;
  reference?: string;
  notes?: string;
  status: "pending" | "verified" | "rejected";
  rejectedReason?: string;
  paymentId?: Id | null;
  decidedBy?: Id | null;
  decidedAt?: Date | null;
  submittedBy: Id;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}
