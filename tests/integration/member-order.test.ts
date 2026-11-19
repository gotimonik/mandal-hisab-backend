import { describe, expect, it } from "vitest";
import { api, ok, setupOrg } from "../helpers/api";

describe("the Mandal's own order of members", () => {
  it("lists members in the dragged order; new members go last", async () => {
    const o = await setupOrg("Order Mandal");
    const t = o.admin.token;
    const add = async (name: string) => (await ok(api("POST", `/orgs/${o.orgId}/members`, { token: t, body: { name } })))._id as string;
    const charlie = await add("Charlie");
    const alice = await add("Alice");
    const bob = await add("Bob");
    const names = async () => (await ok(api("GET", `/orgs/${o.orgId}/members?pageSize=50`, { token: t }))).items.map((m: { name: string }) => m.name);
    const before = await names();
    expect(before.slice(0, 3)).toEqual(["Alice", "Bob", "Charlie"]); // by name until an order is set

    await ok(api("POST", `/orgs/${o.orgId}/members/order`, { token: t, body: { memberIds: [charlie, bob] } }));
    const after = await names();
    expect(after.slice(0, 3)).toEqual(["Charlie", "Bob", "Alice"]); // the rest keep their order after the listed ones
    expect(after).toHaveLength(before.length);

    await add("Aaron");
    expect((await names()).at(-1)).toBe("Aaron"); // a new member goes at the end, not by name

    const sheet = await ok(api("GET", `/orgs/${o.orgId}/members-sheet`, { token: t }));
    expect(sheet.rows.slice(0, 3).map((r: { name: string }) => r.name)).toEqual(["Charlie", "Bob", "Alice"]);

    expect((await api("POST", `/orgs/${o.orgId}/members/order`, { token: t, body: { memberIds: ["6afe9518cb0b0a5408258000"] } })).status).toBe(404);
    expect((await api("POST", `/orgs/${o.orgId}/members/order`, { token: t, body: { memberIds: [alice, alice] } })).status).toBe(400);
  });
});
