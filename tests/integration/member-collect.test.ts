import { beforeAll, describe, expect, it } from "vitest";
import { api, makePlatformAdmin, ok, registerAndLogin, uniq } from "../helpers/api";

/** Collecting a member's hapta and upad interest together, from one screen. */

const todayIST = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const thisMonth = () => todayIST().slice(0, 7);
const lastDayOfPrevMonth = () => {
  const [y, m] = thisMonth().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
};

describe("collect hapta and interest together", () => {
  let orgId: string;
  let token: string;
  let bhavesh: string;
  const get = (p: string) => ok(api("GET", `/orgs/${orgId}${p}`, { token }));
  const post = (p: string, body: Record<string, unknown>) => api("POST", `/orgs/${orgId}${p}`, { token, body });

  beforeAll(async () => {
    const admin = await registerAndLogin("Collect Admin");
    token = admin.token;
    const org = await ok(api("POST", "/organizations", { token, body: { name: "Collect Mandal", monthlyHaptaAmount: "500", haptaStartMonth: thisMonth(), creatorIsMember: false } }));
    if (org.status === "pending") {
      const pa = await registerAndLogin("Platform Admin");
      await makePlatformAdmin(pa.userId);
      await ok(api("PATCH", `/platform/organizations/${org.id}`, { token: pa.token, body: { action: "approve" } }));
    }
    orgId = org.id;
    // hapta from this month, due on the 1st (so it is due now); an upad with ₹600 interest unpaid
    await ok(post("/opening-import", {
      dryRun: false,
      cutoverDate: lastDayOfPrevMonth(),
      cash: "30000",
      haptaAmount: "500",
      haptaDueDay: 1,
      upadRate: "1.5",
      members: [{ name: "Bhavesh Patel", shares: 2, savings: "10000", upads: [{ amount: "20000", interestDue: "600" }] }],
    }));
    bhavesh = (await get("/members?pageSize=10")).items[0]._id;
  });

  it("shows what is due: hapta months and upad interest", async () => {
    const d = await get(`/members/${bhavesh}/dues`);
    expect(d.member.name).toBe("Bhavesh Patel");
    expect(d.hapta.duePaise).toBe(100_000); // 2 shares × ₹500
    expect(d.hapta.months).toHaveLength(1);
    expect(d.interest.toPayPaise).toBeGreaterThanOrEqual(60_000);
    expect(d.totalPaise).toBe(d.hapta.duePaise + d.interest.toPayPaise);
  });

  it("the Due filter lists only members who owe something", async () => {
    const chetna = (await ok(post("/members", { name: "Chetna Shah", joiningDate: `${thisMonth()}-01` })))._id;
    // pay Chetna's hapta so she owes nothing
    const month = await get(`/monthly?month=${thisMonth()}`);
    const row = month.rows.find((r: { memberId: string }) => r.memberId === chetna);
    if (row?.outstandingPaise > 0) await ok(post("/monthly/collect", { installmentId: row.installmentId, amount: String(row.outstandingPaise / 100), date: todayIST(), idempotencyKey: uniq("c") }));
    const all = await get("/members?pageSize=10");
    expect(all.total).toBe(2);
    const due = await get("/members?pageSize=10&due=1");
    expect(due.items.map((m: { name: string }) => m.name)).toEqual(["Bhavesh Patel"]);
    expect(due.total).toBe(1);
  });

  it("records both in one go, and a retry doesn't record them twice", async () => {
    const before = await get(`/members/${bhavesh}/dues`);
    const body = { hapta: "1000", interest: String(before.interest.toPayPaise / 100), date: todayIST(), method: "cash", idempotencyKey: uniq("mc") };
    const r = await ok(post(`/members/${bhavesh}/collect`, body));
    expect(r.hapta.duplicate).toBe(false);
    expect(r.interest.duplicate).toBe(false);
    const again = await ok(post(`/members/${bhavesh}/collect`, body));
    expect(again.hapta.duplicate).toBe(true);
    expect(again.interest.duplicate).toBe(true);

    const after = await get(`/members/${bhavesh}/dues`);
    expect(after.hapta.duePaise).toBe(0);
    expect(after.interest.toPayPaise).toBe(0);
    const list = (await get("/members?pageSize=10")).items.find((m: { _id: string }) => m._id === bhavesh);
    expect(list.outstandingPaise + list.upadInterestDuePaise).toBe(0);
    expect((await get("/members?pageSize=10&due=1")).total).toBe(0);
  });

  it("needs an amount, and no future date", async () => {
    expect((await post(`/members/${bhavesh}/collect`, { hapta: "0", interest: "0", date: todayIST(), idempotencyKey: uniq("mc") })).status).toBe(422);
    expect((await post(`/members/${bhavesh}/collect`, { hapta: "500", date: "2099-01-01", idempotencyKey: uniq("mc") })).status).toBe(400);
  });
});
