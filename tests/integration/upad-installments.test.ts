import { beforeAll, describe, expect, it } from "vitest";
import { api, makePlatformAdmin, ok, registerAndLogin, uniq } from "../helpers/api";

/** Mandal setting: every new upad is returned in fixed monthly installments (with the interest). */

const todayIST = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const thisMonth = () => todayIST().slice(0, 7);
const lastDayOfPrevMonth = () => {
  const [y, m] = thisMonth().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
};
const nextMonth = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7);
};

describe("upad in fixed installments", () => {
  let orgId: string;
  let token: string;
  let ramesh: string;
  const get = (p: string) => ok(api("GET", `/orgs/${orgId}${p}`, { token }));
  const post = (p: string, body: Record<string, unknown>) => api("POST", `/orgs/${orgId}${p}`, { token, body });
  const settings = (fundLoans: Record<string, unknown>) => api("PATCH", `/orgs/${orgId}`, { token, body: { settings: { fundLoans } } });

  beforeAll(async () => {
    const admin = await registerAndLogin("Installment Admin");
    token = admin.token;
    const org = await ok(api("POST", "/organizations", { token, body: { name: "Installment Mandal", monthlyHaptaAmount: "500", haptaStartMonth: thisMonth(), creatorIsMember: false } }));
    if (org.status === "pending") {
      const pa = await registerAndLogin("Platform Admin");
      await makePlatformAdmin(pa.userId);
      await ok(api("PATCH", `/platform/organizations/${org.id}`, { token: pa.token, body: { action: "approve" } }));
    }
    orgId = org.id;
    await ok(post("/opening-import", { dryRun: false, cutoverDate: lastDayOfPrevMonth(), cash: "200000", haptaAmount: "500", haptaDueDay: 1, members: [{ name: "Ramesh Patel", shares: 1, savings: "200000" }] }));
    ramesh = (await get("/members?pageSize=10")).items[0]._id;
  });

  it("is off by default; old upads are returned any time", async () => {
    const org = await ok(api("GET", `/orgs/${orgId}`, { token }));
    expect(org.settings.fundLoans.installments).toEqual({ enabled: false, count: 10 });
    const { loan } = await ok(post("/fund-loans", { memberId: ramesh, amount: "10000", date: todayIST(), monthlyRate: "1", idempotencyKey: uniq("fl") }));
    expect(loan.installmentPlan).toBeNull();
    const detail = await get(`/fund-loans/${loan._id}`);
    expect(detail.installments).toBeNull();
    expect(detail.loan.installment).toBeNull();
  });

  it("turning it on: ₹80,000 → 10 installments of ₹8,000 from next month", async () => {
    await ok(settings({ defaultMonthlyRate: "1", dueDay: 10, allowMemberRequests: true, installments: { enabled: true, count: 10 } }));
    // an older app saving settings without the field keeps it on
    await ok(settings({ defaultMonthlyRate: "1", dueDay: 10, allowMemberRequests: true }));
    expect((await ok(api("GET", `/orgs/${orgId}`, { token }))).settings.fundLoans.installments).toEqual({ enabled: true, count: 10 });

    const { loan } = await ok(post("/fund-loans", { memberId: ramesh, amount: "80000", date: todayIST(), idempotencyKey: uniq("fl") }));
    expect(loan.installmentPlan).toEqual({ count: 10, amountPaise: 800_000, firstMonth: nextMonth(thisMonth()) });
    const detail = await get(`/fund-loans/${loan._id}`);
    expect(detail.installments.rows).toHaveLength(10);
    expect(detail.installments.duePaise).toBe(0); // nothing due in the month it is given
    expect(detail.installments.next).toMatchObject({ sequence: 1, period: nextMonth(thisMonth()), amountPaise: 800_000 });

    const dues = await get(`/members/${ramesh}/dues`);
    expect(dues.installment.duePaise).toBe(0);
    expect(dues.installment.maxPaise).toBe(8_000_000);

    // returning ₹8,000 early through "collect" pays the first installment ahead
    const r = await ok(post(`/members/${ramesh}/collect`, { installment: "8000", date: todayIST(), method: "cash", idempotencyKey: uniq("mc") }));
    expect(r.installments).toHaveLength(1);
    const after = await get(`/fund-loans/${loan._id}`);
    expect(after.loan.outstandingPaise).toBe(7_200_000);
    expect(after.installments.paidCount).toBe(1);
    expect(after.installments.next).toMatchObject({ sequence: 2 });

    // more than the upad owed is refused, nothing is recorded
    expect((await post(`/members/${ramesh}/collect`, { installment: "100000", date: todayIST(), method: "cash", idempotencyKey: uniq("mc") })).status).toBe(400);
  });

  it("the count can be changed; it only applies to new upads", async () => {
    expect((await settings({ defaultMonthlyRate: "1", dueDay: 10, allowMemberRequests: true, installments: { enabled: true, count: 1 } })).status).toBe(422);
    await ok(settings({ defaultMonthlyRate: "1", dueDay: 10, allowMemberRequests: true, installments: { enabled: true, count: 4 } }));
    const { loan } = await ok(post("/fund-loans", { memberId: ramesh, amount: "1000", date: todayIST(), idempotencyKey: uniq("fl") }));
    expect(loan.installmentPlan).toMatchObject({ count: 4, amountPaise: 25_000 });
    const list = await get("/fund-loans?status=active");
    const big = list.items.find((l: { principalPaise: number }) => l.principalPaise === 8_000_000);
    expect(big.installmentPlan.count).toBe(10);
  });
});
