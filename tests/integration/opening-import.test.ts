import { beforeAll, describe, expect, it } from "vitest";
import { api, makePlatformAdmin, ok, registerAndLogin, uniq } from "../helpers/api";

/**
 * Bringing in a Mandal that ran on paper: 3 members, 5 hapta shares, savings, two running upads
 * (one with unpaid interest) and cash in hand — closed at the end of last month.
 */

const todayIST = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const thisMonth = () => todayIST().slice(0, 7);
const lastDayOfPrevMonth = () => {
  const [y, m] = thisMonth().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
};

async function createMandal(name: string) {
  const admin = await registerAndLogin(`${name} Admin`);
  const org = await ok(api("POST", "/organizations", { token: admin.token, body: { name, monthlyHaptaAmount: "300", haptaStartMonth: thisMonth() } }));
  if (org.status === "pending") {
    const pa = await registerAndLogin("Platform Admin");
    await makePlatformAdmin(pa.userId);
    await ok(api("PATCH", `/platform/organizations/${org.id}`, { token: pa.token, body: { action: "approve" } }));
  }
  return { orgId: org.id as string, admin };
}
type Mandal = Awaited<ReturnType<typeof createMandal>>;

describe("bringing in an existing Mandal from paper", () => {
  let o: Mandal;
  let adminMemberId: string;
  const cutover = lastDayOfPrevMonth();
  const body = () => ({
    cutoverDate: cutover,
    cash: "12000",
    haptaAmount: "500",
    haptaDueDay: 10,
    upadRate: "1.5",
    members: [
      { memberId: adminMemberId, name: "Org Admin", shares: 2, savings: "36000" },
      { name: "Bhavesh Patel", phone: "9876500001", shares: 2, savings: "36000", upads: [{ amount: "20000", givenOn: "2025-03-10", interestDue: "600" }] },
      { name: "Chetna Shah", shares: 1, savings: "18000", upads: [{ amount: "10000", monthlyRate: "2" }] },
    ],
  });
  const run = (b: Record<string, unknown>) => api("POST", `/orgs/${o.orgId}/opening-import`, { token: o.admin.token, body: b });

  beforeAll(async () => {
    o = await createMandal("Paper Mandal");
    const st = await ok(api("GET", `/orgs/${o.orgId}/opening-import`, { token: o.admin.token }));
    expect(st.canImport).toBe(true);
    expect(st.members).toHaveLength(1); // the admin
    adminMemberId = st.members[0]._id;
  });

  it("checks without writing anything and shows the tally", async () => {
    const r = await ok(run({ ...body(), dryRun: true }));
    expect(r.imported).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.totals).toMatchObject({ members: 3, newMembers: 2, shares: 5, savingsPaise: 9_000_000, upadCount: 2, upadPaise: 3_000_000, interestDuePaise: 60_000, cashPaise: 1_200_000, haptaPerMonthPaise: 250_000 });
    // 12,000 cash + 30,000 upad − 90,000 savings → short; flagged, not blocked
    expect(r.totals.mandalOwnPaise).toBe(-4_800_000);
    expect(r.warnings.map((w: { message: string }) => w.message).join()).toMatch(/short/);
    const list = await ok(api("GET", `/orgs/${o.orgId}/members`, { token: o.admin.token }));
    expect(list.items).toHaveLength(1);
  });

  it("reports row problems", async () => {
    const b = body();
    (b.members[1].upads![0] as { givenOn?: string }).givenOn = todayIST();
    b.members.push({ name: "Bhavesh Again", phone: "9876500001", shares: 1, savings: "0" } as never);
    const r = await ok(run({ ...b, cutoverDate: "2099-01-31", dryRun: true }));
    const msgs = r.errors.map((e: { message: string }) => e.message).join(" | ");
    expect(msgs).toMatch(/future/);
    expect(msgs).toMatch(/Same phone as row 2/);
    const r2 = await ok(run({ ...b, dryRun: false }));
    expect(r2.imported).toBe(false); // errors → nothing written
  });

  it("imports: balances, cash, upad (no cash moved), hapta from next month, no joining due", async () => {
    const b = body();
    b.cash = "102000"; // tallies: 1,02,000 + 30,000 − 90,000 = 42,000 Mandal's own money
    const r = await ok(run({ ...b, dryRun: false }));
    expect(r.imported).toBe(true);
    expect(r.totals.mandalOwnPaise).toBe(4_200_000);
    expect(r.haptaStartMonth).toBe(thisMonth());

    const d = await ok(api("GET", `/orgs/${o.orgId}/dashboard`, { token: o.admin.token }));
    expect(d.totals.mandalCashPaise).toBe(10_200_000);
    expect(d.totals.fundLoansOutstandingPaise).toBe(3_000_000);
    expect(d.totals.totalMemberBalancesPaise).toBe(9_000_000);

    const list = await ok(api("GET", `/orgs/${o.orgId}/members`, { token: o.admin.token }));
    expect(list.items).toHaveLength(3);
    const bhavesh = list.items.find((m: { name: string }) => m.name === "Bhavesh Patel");
    const led = await ok(api("GET", `/orgs/${o.orgId}/members/${bhavesh._id}/ledger`, { token: o.admin.token }));
    expect(led.currentBalancePaise).toBe(3_600_000);
    const join = await ok(api("GET", `/orgs/${o.orgId}/members/${bhavesh._id}/joining`, { token: o.admin.token }));
    expect(join.due).toBe(false);

    // hapta: this month only, 2 shares × ₹500
    const month = await ok(api("GET", `/orgs/${o.orgId}/monthly?month=${thisMonth()}`, { token: o.admin.token }));
    expect(month.rows).toHaveLength(3);
    const prev = await ok(api("GET", `/orgs/${o.orgId}/monthly?month=${cutover.slice(0, 7)}`, { token: o.admin.token }));
    expect(prev.rows ?? []).toHaveLength(0);

    // upads: Bhavesh owes the ₹600 brought forward + this month's 1.5% of ₹20,000
    const fl = await ok(api("GET", `/orgs/${o.orgId}/fund-loans`, { token: o.admin.token }));
    const loans = fl.items;
    expect(loans).toHaveLength(2);
    expect(fl.defaultMonthlyRate).toBe("1.5");
    const bl = loans.find((l: { member: { name: string } }) => l.member.name === "Bhavesh Patel");
    expect(bl).toMatchObject({ outstandingPaise: 2_000_000, monthlyRate: "1.5", firstInterestMonth: thisMonth() });
    expect(bl.unpaidMonths).toEqual([cutover.slice(0, 7), thisMonth()]);
    expect(bl.interestDuePaise).toBe(60_000 + 30_000);
    const cl = loans.find((l: { member: { name: string } }) => l.member.name === "Chetna Shah");
    expect(cl).toMatchObject({ monthlyRate: "2", interestDuePaise: 20_000 });

    // the members list shows what each still owes on upad
    const listed = await ok(api("GET", `/orgs/${o.orgId}/members`, { token: o.admin.token }));
    expect(listed.items.find((m: { name: string }) => m.name === "Bhavesh Patel")).toMatchObject({ upadPaise: 2_000_000, upadInterestDuePaise: 90_000 });
    expect(listed.items.find((m: { _id: string }) => m._id === adminMemberId)).toMatchObject({ upadPaise: 0, upadInterestDuePaise: 0 });

    // the hisab sheet to share in the group: per member, totals and each share (5 shares)
    const sheet = await ok(api("GET", `/orgs/${o.orgId}/members-sheet`, { token: o.admin.token }));
    expect(sheet.rows).toHaveLength(3);
    expect(sheet.totals).toMatchObject({ shares: 5, savingsPaise: 9_000_000, upadPaise: 3_000_000, interestDuePaise: 110_000 });
    expect(sheet.cashPaise).toBe(10_200_000);
    expect(sheet.totalPaise).toBe(sheet.cashPaise + 3_000_000 + sheet.totals.haptaDuePaise + 110_000);
    expect(sheet).toMatchObject({ members: 3, byShares: true, parts: 5, eachPaise: Math.floor(sheet.totalPaise / 5) });
    expect(sheet.rows.find((r: { name: string }) => r.name === "Bhavesh Patel")).toMatchObject({ shares: 2, savingsPaise: 3_600_000, upadPaise: 2_000_000, interestDuePaise: 90_000 });
    const bh = sheet.rows.find((r: { name: string }) => r.name === "Bhavesh Patel");
    expect(bh.sharePaise).toBe(sheet.eachPaise * 2);
    expect(bh.netPaise).toBe(bh.sharePaise - 2_000_000 - 90_000 - bh.haptaDuePaise);
    // the nets add up to the cash in hand (less the rounding of each share)
    expect(sheet.cashPaise - sheet.netTotalPaise).toBeGreaterThanOrEqual(0);
    expect(sheet.cashPaise - sheet.netTotalPaise).toBeLessThan(5);

    // cash given to someone to keep: a second cash account + a transfer with a note
    const keeper = await ok(api("POST", `/orgs/${o.orgId}/accounts`, { token: o.admin.token, body: { name: "Cash — Rameshbhai", type: "cash" } }));
    const cashAcc = (await ok(api("GET", `/orgs/${o.orgId}/accounts`, { token: o.admin.token }))).find((a: { type: string; name: string }) => a.type === "cash" && a.name !== "Cash — Rameshbhai");
    await ok(api("POST", `/orgs/${o.orgId}/transfers`, { token: o.admin.token, body: { fromAccountId: cashAcc._id, toAccountId: keeper._id, amount: "48000", date: todayIST(), notes: "given to Rameshbhai to keep", idempotencyKey: uniq("tr") } }));
    const sheet2 = await ok(api("GET", `/orgs/${o.orgId}/members-sheet`, { token: o.admin.token }));
    expect(sheet2.cashPaise).toBe(10_200_000); // the total doesn't change
    expect(sheet2.holders.find((h: { name: string }) => h.name === "Cash — Rameshbhai").balancePaise).toBe(4_800_000);
    expect(sheet2.holders.reduce((s: number, h: { balancePaise: number }) => s + h.balancePaise, 0)).toBe(10_200_000);
    expect(sheet2.movements).toEqual([expect.objectContaining({ from: cashAcc.name, to: "Cash — Rameshbhai", amountPaise: 4_800_000, note: "given to Rameshbhai to keep" })]);

    // and the brought-forward interest is collected like any other
    await ok(api("POST", `/orgs/${o.orgId}/fund-loans/${bl._id}/payments`, { token: o.admin.token, body: { interestAmount: "600", date: todayIST(), idempotencyKey: uniq("flp") } }));
    const d2 = await ok(api("GET", `/orgs/${o.orgId}/dashboard`, { token: o.admin.token }));
    expect(d2.totals.mandalCashPaise).toBe(10_260_000);
  });

  it("runs only once", async () => {
    const r = await run({ ...body(), dryRun: true });
    expect(r.status).toBe(409);
    const st = await ok(api("GET", `/orgs/${o.orgId}/opening-import`, { token: o.admin.token }));
    expect(st.canImport).toBe(false);
    expect(st.done).toMatchObject({ members: 3, upadPaise: 3_000_000 });
  });

  it("is refused once money has been recorded", async () => {
    const m = await createMandal("Busy Mandal");
    const st = await ok(api("GET", `/orgs/${m.orgId}/opening-import`, { token: m.admin.token }));
    const month = await ok(api("GET", `/orgs/${m.orgId}/monthly?month=${thisMonth()}`, { token: m.admin.token }));
    await ok(api("POST", `/orgs/${m.orgId}/monthly/collect`, { token: m.admin.token, body: { installmentId: month.rows[0].installmentId, amount: "300", date: todayIST(), idempotencyKey: uniq("c") } }));
    const r = await api("POST", `/orgs/${m.orgId}/opening-import`, { token: m.admin.token, body: { cutoverDate: lastDayOfPrevMonth(), cash: "0", haptaAmount: "300", members: [{ memberId: st.members[0]._id, name: "Org Admin" }] } });
    expect(r.status).toBe(409);
    expect(r.error?.message).toMatch(/already been recorded/);
  });
});
