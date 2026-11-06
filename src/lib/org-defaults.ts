import { DEFAULT_CURRENCY } from "./currency";
import { DEFAULT_MANAGER_FLAGS } from "./permissions";
import { badRequest } from "./errors";
import type { OrganizationDoc, OrganizationSettings } from "@/types/models";

/**
 * Payment methods: cash always, plus UPI when the Mandal turns it on in settings (settings.upi).
 * MandalHisab never moves money: a UPI payment is paid straight to the Mandal's own UPI ID and
 * only recorded here. Bank transfers and cheques are not offered. org.settings.paymentMethods is
 * derived from settings.upi on load, so every method check reads it. Old records keep the method
 * they were saved with.
 */
export const SUPPORTED_PAYMENT_METHODS = ["cash", "upi"] as const;
export type SupportedPaymentMethod = (typeof SUPPORTED_PAYMENT_METHODS)[number];
export const UNSUPPORTED_METHOD_MESSAGE = "Choose cash or UPI";

/** (boolean, not a type guard: schemas keep `method: string` so internal methods like "settlement" still fit) */
export const isSupportedMethod = (m: string): boolean => (SUPPORTED_PAYMENT_METHODS as readonly string[]).includes(m);

/** Throws unless this Mandal accepts the method right now (UPI only when turned on). */
export function assertMethodEnabled(org: Pick<OrganizationDoc, "settings">, method: string) {
  if (org.settings.paymentMethods.includes(method)) return;
  throw badRequest(method === "upi" ? "UPI is not turned on for this Mandal. An admin can turn it on in Settings" : UNSUPPORTED_METHOD_MESSAGE);
}

/** UPI transaction id (UTR / RRN): 12 digits on every UPI app's payment screen. */
export const UTR_PATTERN = /^\d{12}$/;
export const UTR_MESSAGE = "Enter the 12-digit UPI transaction ID (UTR)";

/** A UPI ID (VPA), e.g. gotimandal@okaxis or 9876543210@ybl. */
export const UPI_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;

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
    paymentMethods: ["cash"],
    upi: { enabled: false, accountId: null },
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
  const upi = { ...d.upi, ...(s.upi ?? {}) };
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
    upi,
    // Derived, whatever was saved before (Mandals from the cash-only days had other methods saved).
    paymentMethods: upi.enabled && upi.accountId ? ["cash", "upi"] : ["cash"],
  };
  return org;
}
