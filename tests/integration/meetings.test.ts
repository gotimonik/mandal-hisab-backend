import { beforeAll, describe, expect, it } from "vitest";
import { api, makePlatformAdmin, ok, registerAndLogin, uniq } from "../helpers/api";

/** Mandal meet-ups: the admin calls one (place defaults to the Mandal's address), every member is told. */

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe("Mandal meetings", () => {
  let orgId: string;
  let admin: { token: string; userId: string };
  let member: { token: string; userId: string };
  const types = async (token: string) => (await ok(api("GET", `/notifications?orgId=${orgId}&pageSize=100`, { token }))).items as any[];
  const create = (token: string, body: Record<string, unknown>) => api("POST", `/orgs/${orgId}/meetings`, { token, body: { idempotencyKey: uniq("mt"), ...body } });

  beforeAll(async () => {
    admin = await registerAndLogin("Meeting Admin");
    const org = await ok(api("POST", "/organizations", { token: admin.token, body: { name: "Meeting Mandal", monthlyHaptaAmount: "500", haptaStartMonth: "2026-07" } }));
    orgId = org.id;
    if (org.status === "pending") {
      const pa = await registerAndLogin("Platform Admin");
      await makePlatformAdmin(pa.userId);
      await ok(api("PATCH", `/platform/organizations/${orgId}`, { token: pa.token, body: { action: "approve" } }));
    }
    member = await registerAndLogin("Meeting Member");
    await ok(api("POST", "/organizations/join", { token: member.token, body: { code: org.code } }));
    const pending = await ok<any[]>(api("GET", `/orgs/${orgId}/memberships?status=pending`, { token: admin.token }));
    await ok(api("PATCH", `/orgs/${orgId}/memberships/${pending.find((x) => x.user._id === member.userId)._id}`, { token: admin.token, body: { action: "approve", role: "member" } }));
  });

  it("needs a place: the Mandal's address, or one the admin types", async () => {
    const r = await create(admin.token, { date: future(5), time: "18:30" });
    expect(r.status).toBe(400);
    expect(r.error?.message).toMatch(/where the meeting is/);
    await ok(api("PATCH", `/orgs/${orgId}`, { token: admin.token, body: { address: "Patel Samaj Hall, Ring Road", city: "Surat" } }));
    const list = await ok(api("GET", `/orgs/${orgId}/meetings`, { token: admin.token }));
    expect(list.defaultPlace).toBe("Patel Samaj Hall, Ring Road, Surat");
    expect(list.canManage).toBe(true);
  });

  it("the admin calls a meeting → every member is notified with date, time, place and events", async () => {
    const date = future(10);
    const { meeting } = await ok(create(admin.token, { date, time: "18:30", events: "Navratri planning and dinner" }));
    expect(meeting).toMatchObject({ place: "Patel Samaj Hall, Ring Road, Surat", time: "18:30", status: "scheduled" });
    const [n] = (await types(member.token)).filter((x) => x.type === "meeting.scheduled");
    expect(n.title).toMatch(/^Mandal meeting · \d{2}\/\d{2}\/\d{4}$/);
    expect(n.body).toMatch(/^The Mandal meets on \w+day evening, 6:30 pm \(\d{2}\/\d{2}\/\d{4}\), at Patel Samaj Hall, Ring Road, Surat\./);
    expect(n.body).toContain("Also that day: Navratri planning and dinner");
    expect(n.link).toBe(`/org/${orgId}/meetings`);
    // the admin who called it isn't notified of their own meeting
    expect((await types(admin.token)).some((x) => x.type === "meeting.scheduled")).toBe(false);
    // members see it, and on their dashboard
    const seen = await ok(api("GET", `/orgs/${orgId}/meetings`, { token: member.token }));
    expect(seen.upcoming.map((m: any) => m._id)).toContain(meeting._id);
    expect(seen.canManage).toBe(false);
    const d = await ok(api("GET", `/orgs/${orgId}/dashboard`, { token: member.token }));
    expect(d.nextMeeting._id).toBe(meeting._id);
  });

  it("a typed place is used instead of the address; past dates and members are refused", async () => {
    const { meeting } = await ok(create(admin.token, { date: future(3), time: "09:00", place: "Ambaji temple ground" }));
    expect(meeting.place).toBe("Ambaji temple ground");
    expect((await create(admin.token, { date: "2020-01-01", time: "09:00" })).status).toBe(400);
    expect((await create(admin.token, { date: future(3), time: "25:00" })).status).toBe(422);
    expect((await create(member.token, { date: future(3), time: "09:00" })).status).toBe(403);
    const d = await ok(api("GET", `/orgs/${orgId}/dashboard`, { token: admin.token }));
    expect(d.nextMeeting._id).toBe(meeting._id); // the soonest one
  });

  it("cancelling tells everyone, once", async () => {
    const { meeting } = await ok(create(admin.token, { date: future(20), time: "17:00" }));
    expect((await api("POST", `/orgs/${orgId}/meetings/${meeting._id}/cancel`, { token: member.token, body: {} })).status).toBe(403);
    await ok(api("POST", `/orgs/${orgId}/meetings/${meeting._id}/cancel`, { token: admin.token, body: { reason: "Hall not available" } }));
    expect((await api("POST", `/orgs/${orgId}/meetings/${meeting._id}/cancel`, { token: admin.token, body: {} })).status).toBe(409);
    const [n] = (await types(member.token)).filter((x) => x.type === "meeting.cancelled");
    expect(n.body).toMatch(/is cancelled: Hall not available\.$/);
  });

  it("a meeting tomorrow says 'tomorrow' — in the member's language", async () => {
    await ok(api("PATCH", "/auth/me", { token: member.token, body: { language: "gu" } }));
    await ok(create(admin.token, { date: future(1), time: "18:30", place: "પ્રમુખ છાયા" }));
    const [n] = (await types(member.token)).filter((x) => x.type === "meeting.scheduled");
    expect(n.body).toMatch(/^કાલે સાંજે 6:30 વાગ્યે, તા\. \d{2}\/\d{2}\/\d{4} ના રોજ પ્રમુખ છાયા માં મંડળ રાખેલ છે\.$/);
  });
});
