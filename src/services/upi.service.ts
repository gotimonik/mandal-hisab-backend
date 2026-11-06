import type { ObjectId } from "mongodb";
import { cols } from "@/lib/collections";
import { badRequest, conflict } from "@/lib/errors";
import { UTR_MESSAGE, UTR_PATTERN } from "@/lib/org-defaults";
import type { OrganizationDoc } from "@/types/models";

/**
 * UPI in a Mandal: members pay the Mandal's own UPI ID straight from PhonePe / GPay / any UPI app
 * (MandalHisab never touches the money), then report it with the UPI transaction id (UTR) and an
 * admin verifies it like any other "I have paid".
 */

/** What the app needs to open a UPI app / show a QR for paying this Mandal; null when UPI is off. */
export async function upiPayInfo(org: Pick<OrganizationDoc, "_id" | "name" | "settings">) {
  const { enabled, accountId } = org.settings.upi;
  if (!enabled || !accountId) return null;
  const fa = await (await cols()).financialAccounts.findOne({ _id: accountId, organizationId: org._id, isActive: true, type: "upi" }, { projection: { upiId: 1, name: 1 } });
  if (!fa?.upiId) return null;
  return { upiId: fa.upiId, payeeName: org.name, accountId: fa._id };
}

/** The UTR a member typed, cleaned up (spaces / dashes dropped) and checked. */
export function normalizeUtr(reference: string | undefined): string {
  const utr = (reference ?? "").replace(/[\s-]/g, "");
  if (!UTR_PATTERN.test(utr)) throw badRequest(UTR_MESSAGE);
  return utr;
}

/**
 * The same UPI payment can't be reported or recorded twice in a Mandal (a member re-submitting,
 * or a member and an admin both entering it). Rejected and reversed entries don't count.
 */
export async function assertUtrUnused(orgId: ObjectId, utr: string) {
  const c = await cols();
  const [payment, claim, interest] = await Promise.all([
    c.payments.findOne({ organizationId: orgId, method: "upi", reference: utr, status: { $in: ["pending", "verified"] } }, { projection: { status: 1 } }),
    c.upadPaymentClaims.findOne({ organizationId: orgId, method: "upi", reference: utr, status: { $in: ["pending", "verified"] } }, { projection: { status: 1 } }),
    c.upadInterestPayments.findOne({ organizationId: orgId, method: "upi", reference: utr, status: "valid" }, { projection: { _id: 1 } }),
  ]);
  const hit = payment ?? claim;
  if (hit?.status === "pending") throw conflict(`UPI payment ${utr} has already been reported and is waiting to be verified`);
  if (hit || interest) throw conflict(`UPI payment ${utr} has already been recorded`);
}
