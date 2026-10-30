import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUser, api, ok, setupOrg } from "../helpers/api";
import { setStorageForTests, type StorageProvider } from "@/services/upload.service";

/** In-memory stand-in for Vercel Blob. */
const stored = new Map<string, string>();
const fake: StorageProvider = {
  async put(path, _data, contentType) {
    const url = `https://blob.test/${path}`;
    stored.set(url, contentType);
    return url;
  },
  async del(url) {
    stored.delete(url);
  },
};

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
function image(magic: number[], size: number, type: string, name = "logo") {
  const bytes = new Uint8Array(size);
  bytes.set(magic);
  return new File([bytes], name, { type });
}
const form = (f: File) => {
  const fd = new FormData();
  fd.set("file", f);
  return fd;
};

describe("Mandal logo upload", () => {
  let org: Awaited<ReturnType<typeof setupOrg>>;

  beforeAll(async () => {
    setStorageForTests(fake);
    org = await setupOrg("Logo Mandal");
  });
  afterAll(() => setStorageForTests(undefined));

  const upload = (f: File, token = org.admin.token) => api("POST", `/orgs/${org.orgId}/logo`, { token, form: form(f) });
  const current = async () => (await ok(api("GET", `/orgs/${org.orgId}`, { token: org.admin.token }))).logoUrl as string | null;

  it("stores a logo up to 1 MB and sets it on the Mandal", async () => {
    const r = await ok(upload(image(PNG, 1024 * 1024, "image/png")));
    expect(r.logoUrl).toMatch(new RegExp(`^https://blob\\.test/orgs/${org.orgId}/logo/[a-f0-9]{32}\\.png$`));
    expect(stored.get(r.logoUrl)).toBe("image/png");
    expect(await current()).toBe(r.logoUrl);
  });

  it("replaces the old logo and deletes its file", async () => {
    const before = await current();
    const r = await ok(upload(image(JPEG, 2000, "image/jpeg")));
    expect(r.logoUrl).toMatch(/\.jpg$/);
    expect(stored.has(before!)).toBe(false);
    expect(stored.has(r.logoUrl)).toBe(true);
    expect(await current()).toBe(r.logoUrl);
  });

  it("rejects files over 1 MB, non-images, PDFs and fakes", async () => {
    const big = await upload(image(PNG, 1024 * 1024 + 1, "image/png"));
    expect(big.status).toBe(400);
    expect(big.error?.message).toBe("The logo must be 1 MB or smaller");
    const pdf = await upload(image([0x25, 0x50, 0x44, 0x46], 500, "application/pdf"));
    expect(pdf.error?.message).toBe("The logo must be a PNG, JPEG or WEBP image");
    const svg = await upload(new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }));
    expect(svg.status).toBe(400);
    const fakePng = await upload(image(JPEG, 500, "image/png"));
    expect(fakePng.error?.message).toBe("The file content does not match its type");
  });

  it("only admins can change it", async () => {
    const member = await addUser(org.orgId, org.code, org.admin.token, "member");
    expect((await upload(image(PNG, 500, "image/png"), member.token)).status).toBe(403);
    expect((await api("DELETE", `/orgs/${org.orgId}/logo`, { token: member.token })).status).toBe(403);
  });

  it("removes the logo and its file", async () => {
    const before = await current();
    expect((await ok(api("DELETE", `/orgs/${org.orgId}/logo`, { token: org.admin.token }))).logoUrl).toBeNull();
    expect(await current()).toBeNull();
    expect(stored.has(before!)).toBe(false);
  });

  it("never deletes a logo URL it didn't store", async () => {
    const outside = "https://example.com/my-logo.png";
    await ok(api("PATCH", `/orgs/${org.orgId}`, { token: org.admin.token, body: { logoUrl: outside } }));
    stored.set(outside, "image/png");
    await ok(upload(image(PNG, 500, "image/png")));
    expect(stored.has(outside)).toBe(true);
  });
});
