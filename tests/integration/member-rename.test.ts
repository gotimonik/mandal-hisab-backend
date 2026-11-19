import { describe, expect, it } from "vitest";
import { api, setupOrg, ok } from "../helpers/api";

describe("renaming members (e.g. to Gujarati)", () => {
  it("renames many at once and keeps finding them by the English name", async () => {
    const o = await setupOrg("Rename Mandal");
    const t = o.admin.token;
    const a = await ok(api("POST", `/orgs/${o.orgId}/members`, { token: t, body: { name: "Abhishek Goti" } }));
    const b = await ok(api("POST", `/orgs/${o.orgId}/members`, { token: t, body: { name: "Vishal Goti" } }));
    const r = await ok(api("POST", `/orgs/${o.orgId}/members/rename`, { token: t, body: { items: [{ memberId: a._id, name: "અભિષેક ગોટી" }, { memberId: b._id, name: "Vishal Goti" }] } }));
    expect(r.renamed).toBe(1); // unchanged names are skipped

    const m = await ok(api("GET", `/orgs/${o.orgId}/members/${a._id}`, { token: t }));
    expect(m.member).toMatchObject({ name: "અભિષેક ગોટી", nameEnglish: "Abhishek Goti" });
    for (const q of ["abhishek", "અભિષેક", "abhishek goti"]) {
      const found = await ok(api("GET", `/orgs/${o.orgId}/members?q=${encodeURIComponent(q)}`, { token: t }));
      expect(found.items.map((x: { _id: string }) => x._id)).toContain(a._id);
    }
    // the automatic English spelling of the Gujarati name works too
    const auto = await ok(api("GET", `/orgs/${o.orgId}/members?q=goti`, { token: t }));
    expect(auto.items.map((x: { _id: string }) => x._id)).toEqual(expect.arrayContaining([a._id, b._id]));
    expect((await api("POST", `/orgs/${o.orgId}/members/rename`, { token: t, body: { items: [{ memberId: a._id, name: "x" }] } })).status).toBe(422);
  });
});
