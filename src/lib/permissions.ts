import type { ManagerPermissionFlags, OrgRole } from "@/types/models";

export const PERMISSIONS = [
  "org.view",
  "org.settings.manage",
  "memberships.manage",
  "members.view",
  "members.manage",
  "schemes.view",
  "schemes.manage",
  "installments.view",
  "installments.manage",
  "payments.view",
  "payments.record",
  "payments.verify",
  "payments.reverse",
  "donations.record",
  "expenses.view",
  "expenses.submit",
  "expenses.approve",
  "accounts.view",
  "accounts.manage",
  "transactions.view",
  "transactions.adjust",
  "loans.view",
  "loans.manage",
  "loans.approve",
  "interest.manage",
  "reports.view",
  "reports.sensitive",
  "audit.view",
  "self.view",
  "self.submitPayment",
  "interest.distribute",
  "withdrawals.record",
  "members.balanceAdjust",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const MANAGER_BASE: Permission[] = [
  "org.view",
  "members.view",
  "members.manage",
  "schemes.view",
  "installments.view",
  "installments.manage",
  "payments.view",
  "payments.record",
  "donations.record",
  "expenses.view",
  "expenses.submit",
  "accounts.view",
  "transactions.view",
  "loans.view",
  "reports.view",
  "self.view",
  "self.submitPayment",
];

const MEMBER_BASE: Permission[] = ["org.view", "self.view", "self.submitPayment"];

export const DEFAULT_MANAGER_FLAGS: ManagerPermissionFlags = {
  canCreateLoans: false,
  canApproveLoans: false,
  canModifyInterest: false,
  canApproveExpenses: false,
  canVerifyPayments: true,
  canManageSchemes: false,
  canAccessSensitiveReports: false,
  canManageAccounts: false,
  canRecordWithdrawals: false,
  canDistributeInterest: false,
};

/** Resolve the effective permission set for a role within an organization. */
export function permissionsFor(role: OrgRole, flags: ManagerPermissionFlags): Set<Permission> {
  if (role === "admin") return new Set(PERMISSIONS);
  if (role === "member") return new Set(MEMBER_BASE);
  const p = new Set<Permission>(MANAGER_BASE);
  if (flags.canCreateLoans) p.add("loans.manage");
  if (flags.canApproveLoans) p.add("loans.approve");
  if (flags.canModifyInterest) p.add("interest.manage");
  if (flags.canApproveExpenses) p.add("expenses.approve");
  if (flags.canVerifyPayments) {
    p.add("payments.verify");
  }
  if (flags.canManageSchemes) p.add("schemes.manage");
  if (flags.canAccessSensitiveReports) p.add("reports.sensitive");
  if (flags.canRecordWithdrawals) p.add("withdrawals.record");
  if (flags.canDistributeInterest) p.add("interest.distribute");
  if (flags.canManageAccounts) {
    p.add("accounts.manage");
  }
  return p;
}
