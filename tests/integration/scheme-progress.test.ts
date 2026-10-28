import { describe, expect, it } from "vitest";
import { addUser, api, ok, setupOrg, uniq } from "../helpers/api";

const ymd = (d: Date) => d.toISOString().slice(0, 10);

describe("scheme page: whole schedule per member", () => {
  it("shows money paid ahead for future installments", async () => {
    const o = await setupOrg();
    // a scheme that starts in two months, so every installment is still in the future
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1));
    const member = await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: `Member ${uniq()}` } }));
    const scheme = await ok(
      api("POST", `/orgs/${o.orgId}/schemes`, { token: o.admin.token, body: { name: `Monthly ${uniq()}`, startDate: ymd(start), frequency: "monthly", dueDay: 10, amount: "1000", numberOfInstallments: 12 } }),
    );
    await ok(api("POST", `/orgs/${o.orgId}/schemes/${scheme._id}/enroll`, { token: o.admin.token, body: { members: [{ memberId: member._id }] } }));

    // pays three months in advance
    await ok(
      api("POST", `/orgs/${o.orgId}/payments`, {
        token: o.admin.token,
        body: { kind: "hapta", memberId: member._id, amount: "3000", date: ymd(now), method: "cash", accountId: o.cashAccountId, idempotencyKey: uniq("pay") },
      }),
    );

    const d = await ok(api("GET", `/orgs/${o.orgId}/schemes/${scheme._id}`, { token: o.admin.token }));
    const e = d.enrollments.find((x: any) => x.member._id === member._id);
    expect(e.duePaise).toBe(0); // nothing due yet
    expect(e.paidPaise).toBe(0);
    expect(e.paidAheadPaise).toBe(300_000);
    expect(e.totalPaidPaise).toBe(300_000);
    expect(e.paidCount).toBe(3);
    expect(e.schedule.slice(0, 4).map((i: any) => i.status)).toEqual(["paid", "paid", "paid", "upcoming"]);
    expect(e.paidThrough).toBe(e.schedule[2].periodLabel);
    expect(e.nextDue).toMatchObject({ periodLabel: e.schedule[3].periodLabel, outstandingPaise: 100_000 });
    expect(e.installmentCount).toBe(e.schedule.length);
  });

  it("member can say which scheme an \"I have paid\" report is for", async () => {
    const o = await setupOrg();
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const member = await ok(api("POST", `/orgs/${o.orgId}/members`, { token: o.admin.token, body: { name: `Member ${uniq()}` } }));
    const mk = async (name: string, amount: string) => {
      const s = await ok(api("POST", `/orgs/${o.orgId}/schemes`, { token: o.admin.token, body: { name, startDate: ymd(start), frequency: "monthly", dueDay: 10, amount, numberOfInstallments: 6 } }));
      await ok(api("POST", `/orgs/${o.orgId}/schemes/${s._id}/enroll`, { token: o.admin.token, body: { members: [{ memberId: member._id }] } }));
      return s;
    };
    const a = await mk(`A ${uniq()}`, "1000");
    const b = await mk(`B ${uniq()}`, "500");
    const other = await ok(api("POST", `/orgs/${o.orgId}/schemes`, { token: o.admin.token, body: { name: `C ${uniq()}`, startDate: ymd(start), frequency: "monthly", dueDay: 10, amount: "100", numberOfInstallments: 2 } }));
    const u = await addUser(o.orgId, o.code, o.admin.token, "member", member._id);

    const opts = await ok(api("GET", `/orgs/${o.orgId}/me/payment-options`, { token: u.token }));
    expect(opts.schemes.map((x: any) => x._id).sort()).toEqual([a._id, b._id].sort());
    const sb = opts.schemes.find((x: any) => x._id === b._id);
    expect(sb).toMatchObject({ duePaise: 0, remainingPaise: 300_000, nextPaise: 50_000 });

    // ₹1,000 for scheme B goes to B's first two months, not to A
    const body = { purpose: "hapta", amount: "1000", date: ymd(now), method: "cash", idempotencyKey: uniq("req") };
    const r = await ok(api("POST", `/orgs/${o.orgId}/me/payment-requests`, { token: u.token, body: { ...body, schemeId: b._id } }));
    expect(r.payment.schemeId).toBe(b._id);
    expect(r.payment.allocations).toHaveLength(2);
    // a scheme the member isn't in is refused
    const bad = await api("POST", `/orgs/${o.orgId}/me/payment-requests`, { token: u.token, body: { ...body, schemeId: other._id, idempotencyKey: uniq("req") } });
    expect(bad.status).toBe(404);

    // dashboards are split by scheme too
    const adm = await ok(api("GET", `/orgs/${o.orgId}/dashboard`, { token: o.admin.token }));
    const da = adm.schemes.find((x: any) => x._id === a._id);
    expect(da).toMatchObject({ name: a.name, members: 1, plannedPaise: 600_000, collectedPaise: 0, outstandingPaise: 0 });
    expect(adm.schemes.map((x: any) => x._id)).toEqual(expect.arrayContaining([a._id, b._id, other._id]));
    // installments grouped per scheme and per member
    const byScheme = await ok(api("GET", `/orgs/${o.orgId}/installments/groups?by=scheme`, { token: o.admin.token }));
    const ga = byScheme.items.find((x: any) => x._id === a._id);
    expect(ga).toMatchObject({ name: a.name, count: 6, others: 1, plannedPaise: 600_000, paidPaise: 0, upcomingPaise: 600_000 });
    const byMember = await ok(api("GET", `/orgs/${o.orgId}/installments/groups?by=member`, { token: o.admin.token }));
    const gm = byMember.items.find((x: any) => x._id === member._id);
    expect(gm).toMatchObject({ count: 12, others: 2, plannedPaise: 900_000 });
    expect(byMember.total).toBe(1);
    const bad2 = await api("GET", `/orgs/${o.orgId}/installments/groups?by=nope`, { token: o.admin.token });
    expect(bad2.status).toBe(422);
    const mine = await ok(api("GET", `/orgs/${o.orgId}/dashboard`, { token: u.token }));
    expect(mine.schemes.map((x: any) => x.scheme._id).sort()).toEqual([a._id, b._id].sort());
  });
});
