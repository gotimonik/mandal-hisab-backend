import { beforeAll, describe, expect, it } from "vitest";
import { api, makePlatformAdmin, ok, registerAndLogin, uniq } from "../helpers/api";

/** Moving the month the hapta starts — e.g. after a reset left months of "overdue" hapta. */

const todayIST = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const thisMonth = () => todayIST().slice(0, 7);
const addMonths = (m: string, n: number) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7);
};

async function createMandal(name: string, startMonth: string) {
  const admin = await registerAndLogin(`${name} Admin`);
  const org = await ok(api("POST", "/organizations", { token: admin.token, body: { name, monthlyHaptaAmount: "300", haptaStartMonth: startMonth } }));
  if (org.status === "pending") {
    const pa = await registerAndLogin("Platform Admin");
    await makePlatformAdmin(pa.userId);
    await ok(api("PATCH", `/platform/organizations/${org.id}`, { token: pa.token, body: { action: "approve" } }));
  }
  return { orgId: org.id as string, admin };
}

describe("changing the month the hapta starts", () => {
  let o: Awaited<ReturnType<typeof createMandal>>;
  let late: string;
  const twoAgo = addMonths(thisMonth(), -2);
  const month = (m: string) => ok(api("GET", `/orgs/${o.orgId}/monthly?month=${m}`, { token: o.admin.token }));
  const move = (body: Record<string, unknown>) => api("POST", `/orgs/${o.orgId}/monthly-hapta/start`, { token: o.admin.token, body });

  beforeAll(async () => {
    o = await createMandal("Start Month Mandal", twoAgo);
    late = (await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: "Late Joiner", joiningDate: `${thisMonth()}-01`, haptaShares: 2 } })))._id;
  });

  it("moves the start later: old months disappear, nobody owes a joining amount", async () => {
    expect((await month(twoAgo)).rows.length).toBeGreaterThan(0);
    const r = await ok(move({ startMonth: thisMonth() }));
    expect(r.startMonth).toBe(thisMonth());
    expect((await month(twoAgo)).rows).toHaveLength(0);
    const now = await month(thisMonth());
    expect(now.rows).toHaveLength(2);
    expect(now.rows.find((x: { memberId: string }) => x.memberId === late).expectedPaise).toBe(60_000); // 2 shares kept
    expect((await ok(api("GET", `/orgs/${o.orgId}/members/${late}/joining`, { token: o.admin.token }))).due).toBe(false);
    const org = await ok(api("GET", `/orgs/${o.orgId}`, { token: o.admin.token }));
    expect(String(org.settings.monthlyHapta.startDate).slice(0, 7)).toBe(thisMonth());
  });

  it("moves it earlier using joining dates: a later joiner starts in their month and owes a joining amount", async () => {
    await ok(move({ startMonth: twoAgo, founders: false }));
    const old = await month(twoAgo);
    expect(old.rows.map((x: { memberId: string }) => x.memberId)).not.toContain(late);
    expect((await ok(api("GET", `/orgs/${o.orgId}/members/${late}/joining`, { token: o.admin.token }))).due).toBe(true);
  });

  it("refuses an end month before the start, and once hapta is collected", async () => {
    await ok(api("PATCH", `/orgs/${o.orgId}/end-month`, { token: o.admin.token, body: { endMonth: addMonths(thisMonth(), 6) } }));
    const tooLate = await move({ startMonth: addMonths(thisMonth(), 7) });
    expect(tooLate.status).toBe(400);
    expect(tooLate.error?.message).toMatch(/ends before/);

    await ok(move({ startMonth: thisMonth() }));
    const now = await month(thisMonth());
    await ok(api("POST", `/orgs/${o.orgId}/monthly/collect`, { token: o.admin.token, body: { installmentId: now.rows[0].installmentId, amount: "300", date: todayIST(), idempotencyKey: uniq("c") } }));
    const r = await move({ startMonth: addMonths(thisMonth(), 1) });
    expect(r.status).toBe(400);
    expect(r.error?.message).toMatch(/already been collected/);
  });
});
