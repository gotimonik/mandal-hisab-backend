import { DEFAULT_CURRENCY } from "./currency";
import { DEFAULT_MANAGER_FLAGS } from "./permissions";
import type { OrganizationDoc, OrganizationSettings } from "@/types/models";

export const DEFAULT_EXPENSE_CATEGORIES = [
  { key: "festival", name: "Festival & events" },
  { key: "puja", name: "Puja & rituals" },
  { key: "decoration", name: "Decoration" },
  { key: "food", name: "Food & prasad" },
  { key: "rent", name: "Rent & venue" },
  { key: "utilities", name: "Electricity & utilities" },
  { key: "maintenance", name: "Repairs & maintenance" },
  { key: "printing", name: "Printing & stationery" },
  { key: "transport", name: "Transport" },
  { key: "charity", name: "Charity & welfare" },
  { key: "bank_charges", name: "Bank charges" },
  { key: "misc", name: "Miscellaneous" },
].map((c) => ({ ...c, isActive: true }));

export function defaultSettings(): OrganizationSettings {
  return {
    financialYearStartMonth: 4,
    currency: DEFAULT_CURRENCY,
    timezone: "Asia/Kolkata",
    receiptPrefix: "RCPT",
    requirePaymentVerification: true,
    expenseApprovalThresholdPaise: 0,
    reminderDaysBefore: [3, 0],
    overdueReminderEveryDays: 7,
    managerPermissions: { ...DEFAULT_MANAGER_FLAGS },
    expenseCategories: DEFAULT_EXPENSE_CATEGORIES,
    paymentMethods: ["cash", "upi", "bank_transfer", "cheque"],
    installmentHorizonMonths: 12,
    monthlyHapta: null,
    haptaTreatment: "member_savings",
    interest: { defaultMode: "manual", monthlyRate: "1", basis: "previous_month_closing" },
    withdrawals: { allowExceptions: false },
    fundLoans: { defaultMonthlyRate: "2", dueDay: 10, allowMemberRequests: true },
    membership: { discoverable: true, allowJoinRequests: true, autoCreateMember: true },
  };
}

/**
 * Organizations created before a setting existed get its default at read time, so old
 * documents keep working without a migration. Only fields that are missing are filled.
 */
export function withSettingsDefaults<T extends Pick<OrganizationDoc, "settings">>(org: T): T {
  const d = defaultSettings();
  const s = (org.settings ?? {}) as Partial<OrganizationSettings>;
  org.settings = {
    ...d,
    ...s,
    // Organizations that existed before member-savings support keep their original (income) treatment.
    haptaTreatment: s.haptaTreatment ?? (s.monthlyHapta === undefined ? "income" : d.haptaTreatment),
    interest: { ...d.interest, ...(s.interest ?? {}) },
    withdrawals: { ...d.withdrawals, ...(s.withdrawals ?? {}) },
    fundLoans: { ...d.fundLoans, ...(s.fundLoans ?? {}) },
    membership: { ...d.membership, ...(s.membership ?? {}) },
    managerPermissions: { ...d.managerPermissions, ...(s.managerPermissions ?? {}) },
  };
  return org;
}
