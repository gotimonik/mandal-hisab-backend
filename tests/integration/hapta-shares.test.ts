import { beforeAll, describe, expect, it } from "vitest";
import { api, makePlatformAdmin, ok, registerAndLogin, uniq } from "../helpers/api";

/**
 * Hapta shares: one member (one name, one login) can pay several haptas a month — e.g. Monik pays
 * 3 × ₹500 = ₹1,500. Savings and interest follow the money; the "per share" figure counts shares.
 */

const nowMonth = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
const addMonths = (m: string, n: number) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7);
};

describe("hapta shares", () => {
  let orgId: string;
  let token: string;
  let monik: string;
  let asha: string;
  const START = addMonths(nowMonth(), -1);
  const THIS = nowMonth();
  const NEXT = addMonths(nowMonth(), 1);
  const month = (m: string) => ok(api("GET", `/orgs/${orgId}/monthly?month=${m}`, { token }));
  const rowOf = async (m: string, memberId: string) => (await month(m)).rows.find((r: any) => r.memberId === memberId);

  beforeAll(async () => {
    const admin = await registerAndLogin("Shares Admin");
    token = admin.token;
    const org = await ok(api("POST", "/organizations", { token, body: { name: "Shares Mandal", monthlyHaptaAmount: "500", haptaStartMonth: START, creatorIsMember: false } }));
    if (org.status === "pending") {
      const pa = await registerAndLogin("Platform Admin");
      await makePlatformAdmin(pa.userId);
      await ok(api("PATCH", `/platform/organizations/${org.id}`, { token: pa.token, body: { action: "approve" } }));
    }
    orgId = org.id;
    monik = (await ok(api("POST", `/orgs/${orgId}/members`, { token, body: { name: "Monik Goti", haptaShares: 3, joiningDate: `${START}-01` } })))._id;
    asha = (await ok(api("POST", `/orgs/${orgId}/members`, { token, body: { name: "Asha Patel", joiningDate: `${START}-01` } })))._id;
  });

  it("a member with 3 shares owes 3 × the hapta every month", async () => {
    const m = await rowOf(START, monik);
    expect(m).toMatchObject({ expectedPaise: 150_000, shares: 3 });
    expect(await rowOf(START, asha)).toMatchObject({ expectedPaise: 50_000, shares: 1 });
    expect((await month(START)).summary.expectedPaise).toBe(200_000);
  });

  it("collecting ₹1,500 pays the month in one go; savings grow by ₹1,500", async () => {
    const m = await rowOf(START, monik);
    await ok(api("POST", `/orgs/${orgId}/monthly/collect`, { token, body: { installmentId: m.installmentId, amount: "1500", date: `${START}-05`, idempotencyKey: uniq("c") } }));
    expect(await rowOf(START, monik)).toMatchObject({ status: "paid", collectedPaise: 150_000 });
    const ledger = await ok(api("GET", `/orgs/${orgId}/members/${monik}/ledger`, { token }));
    expect(ledger.currentBalancePaise).toBe(150_000);
  });

  it("the dashboard counts shares: 4 shares for 2 members", async () => {
    const d = await ok(api("GET", `/orgs/${orgId}/dashboard`, { token }));
    expect(d.totals.activeMembers).toBe(2);
    expect(d.totals.activeShares).toBe(4);
  });

  it("changing the hapta amount keeps the shares (3 × new amount)", async () => {
    await ok(api("PATCH", `/orgs/${orgId}/monthly-hapta`, { token, body: { amount: "600", effectiveMonth: NEXT } }));
    expect(await rowOf(NEXT, monik)).toMatchObject({ expectedPaise: 180_000 });
    expect(await rowOf(NEXT, asha)).toMatchObject({ expectedPaise: 60_000 });
    expect(await rowOf(START, monik)).toMatchObject({ expectedPaise: 150_000 }); // paid month never changes
  });

  it("changing shares updates unpaid months from this month; paid months keep their amount", async () => {
    const r = await ok(api("PATCH", `/orgs/${orgId}/members/${monik}`, { token, body: { haptaShares: 2 } }));
    expect(r.sharesInstallmentsUpdated).toBeGreaterThan(0);
    expect(await rowOf(START, monik)).toMatchObject({ expectedPaise: 150_000, shares: 3 });
    expect(await rowOf(THIS, monik)).toMatchObject({ expectedPaise: 100_000, shares: 2 });
    expect(await rowOf(NEXT, monik)).toMatchObject({ expectedPaise: 120_000, shares: 2 });
    // giving Asha 2 shares works the same way
    await ok(api("PATCH", `/orgs/${orgId}/members/${asha}`, { token, body: { haptaShares: 2 } }));
    expect(await rowOf(THIS, asha)).toMatchObject({ expectedPaise: 100_000 });
    const d = await ok(api("GET", `/orgs/${orgId}/dashboard`, { token }));
    expect(d.totals.activeShares).toBe(4);
  });

  it("shares must be a whole number from 1 to 50", async () => {
    expect((await api("PATCH", `/orgs/${orgId}/members/${monik}`, { token, body: { haptaShares: 0 } })).status).toBe(422);
    expect((await api("POST", `/orgs/${orgId}/members`, { token, body: { name: "Too Many", haptaShares: 51 } })).status).toBe(422);
  });
});
