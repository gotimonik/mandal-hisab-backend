import { ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { env } from "@/config/env";
import { cols } from "@/lib/collections";
import { BCRYPT_ROUNDS, hashPassword, hashToken, needsRehash, randomToken, verifyPassword } from "@/lib/crypto";
import { AppError, badRequest, conflict, isDuplicateKeyError, unauthorized } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth";
import type { UserDoc } from "@/types/models";
import { sendEmail } from "./email.service";
import { renderEmail } from "./email-templates";
import { email, phone } from "@/validators/common";

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), "Password must contain letters and numbers");

/** Registration never accepts role / admin fields: unknown keys are stripped. */
export const RegisterSchema = z.object({
  name: z.string().trim().min(2, "Enter your name").max(100),
  email,
  phone,
  password: passwordSchema,
  /** Token from the invitation link the person followed — proves they own the invited email. */
  inviteToken: z.string().min(10).max(200).optional(),
});

export const LoginSchema = z.object({ email, password: z.string().min(1).max(128) });

export function publicUser(u: UserDoc) {
  return {
    id: u._id.toHexString(),
    name: u.name,
    email: u.email,
    phone: u.phone ?? null,
    emailVerified: !!u.emailVerifiedAt,
    isPlatformAdmin: u.isPlatformAdmin,
    status: u.status,
    createdAt: u.createdAt,
  };
}

/**
 * Unknown emails still pay for one bcrypt compare, so response time doesn't reveal
 * which emails have accounts. Precomputed at the production cost so the first failed
 * login doesn't also pay for generating it.
 */
const DUMMY_HASH_10 = "$2b$10$LfRwklA6cIqVEQNOEoXHy.X5h0TBX8ZdKYl0ahcq25Ox7rnOV2Qlq";
let dummyHash: string | null = BCRYPT_ROUNDS === 10 ? DUMMY_HASH_10 : null;
async function burn(password: string) {
  dummyHash ??= await bcrypt.hash("not-a-real-password", BCRYPT_ROUNDS);
  await bcrypt.compare(password, dummyHash);
}

export async function register(input: z.infer<typeof RegisterSchema>, ip: string) {
  await rateLimit(`register:${ip}`, 10, 3600);
  const c = await cols();
  const now = new Date();
  // Someone who followed an invitation emailed to this exact address has already shown they own it.
  const invited = input.inviteToken
    ? await c.invitations.findOne({ tokenHash: hashToken(input.inviteToken), email: input.email, status: "pending", expiresAt: { $gt: now } }, { projection: { _id: 1 } })
    : null;
  const user: UserDoc = {
    _id: new ObjectId(),
    name: input.name,
    email: input.email,
    phone: input.phone,
    passwordHash: await hashPassword(input.password),
    emailVerifiedAt: invited ? now : null,
    mustVerifyEmail: true,
    isPlatformAdmin: false,
    status: "active",
    sessionVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await c.users.insertOne(user);
  } catch (e) {
    if (isDuplicateKeyError(e)) throw conflict("An account with this email already exists");
    throw e;
  }
  if (!invited) await sendVerificationEmail(user);
  await audit({ actorId: user._id, action: "user.register", entityType: "user", entityId: user._id, ip });
  return publicUser(user);
}

async function issueToken(userId: ObjectId, purpose: "email_verification" | "password_reset", ttlMinutes: number) {
  const c = await cols();
  const token = randomToken();
  await c.authTokens.insertOne({
    _id: new ObjectId(),
    userId,
    purpose,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
    usedAt: null,
    createdAt: new Date(),
  });
  return token;
}

async function sendVerificationEmail(user: UserDoc) {
  const token = await issueToken(user._id, "email_verification", 60 * 48);
  const link = `${env().FRONTEND_URL}/verify-email?token=${encodeURIComponent(token)}`;
  const mail = renderEmail({
    preheader: "One tap to activate your MandalHisab account.",
    heading: "Confirm your email",
    greeting: `Namaste ${user.name.split(" ")[0]},`,
    paragraphs: ["Welcome to MandalHisab! Please confirm this is your email address to activate your account — then you can sign in and open your Mandal."],
    button: { label: "Verify my email", url: link },
    note: "This link expires in 48 hours. If you didn't create a MandalHisab account, you can safely ignore this email.",
    reason: `You're receiving this because ${user.email} was used to create a MandalHisab account.`,
  });
  await sendEmail({ to: user.email, subject: "Confirm your email for MandalHisab", ...mail });
}

export async function resendVerification(auth: AuthContext) {
  if (auth.user.emailVerifiedAt) return { ok: true };
  await rateLimit(`verify-resend:${auth.user._id}`, 5, 3600);
  await sendVerificationEmail(auth.user);
  return { ok: true };
}

async function consumeToken(token: string, purpose: "email_verification" | "password_reset") {
  const c = await cols();
  const doc = await c.authTokens.findOneAndUpdate(
    { tokenHash: hashToken(token), purpose, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!doc) throw badRequest("This link is invalid or has expired");
  return doc;
}

export async function verifyEmail(token: string) {
  const t = await consumeToken(token, "email_verification");
  const c = await cols();
  await c.users.updateOne({ _id: t.userId }, { $set: { emailVerifiedAt: new Date(), updatedAt: new Date() } });
  const u = await c.users.findOne({ _id: t.userId }, { projection: { email: 1 } });
  // The email is returned so the sign-in form can be pre-filled; the token already proved it.
  return { ok: true, email: u?.email ?? null };
}

/**
 * Resend the verification email for someone who can't sign in yet. Always the same answer,
 * so it can't be used to find out which emails have accounts.
 */
export async function resendVerificationByEmail(emailAddr: string, ip: string) {
  await rateLimit(`verify-resend-ip:${ip}`, 10, 3600);
  await rateLimit(`verify-resend-email:${emailAddr}`, 5, 3600);
  const c = await cols();
  const user = await c.users.findOne({ email: emailAddr, status: "active" });
  if (user && !user.emailVerifiedAt) await sendVerificationEmail(user);
  return { ok: true };
}

export async function login(input: z.infer<typeof LoginSchema>, meta: { ip: string; userAgent: string }) {
  // Both rate-limit counters and the user lookup are independent: one round trip, not three.
  const c = await cols();
  const [, , user] = await Promise.all([
    rateLimit(`login-ip:${meta.ip}`, 30, 900),
    rateLimit(`login-email:${input.email}`, 10, 900),
    c.users.findOne({ email: input.email }),
  ]);
  if (!user) {
    await burn(input.password);
    throw unauthorized("Invalid email or password");
  }
  if (!(await verifyPassword(input.password, user.passwordHash))) throw unauthorized("Invalid email or password");
  if (user.status !== "active") throw new AppError("FORBIDDEN", "This account has been deactivated");
  // New accounts (mustVerifyEmail) — or every account when REQUIRE_EMAIL_VERIFICATION is on —
  // can't sign in until the email is verified. Checked after the password, so it reveals nothing.
  if ((user.mustVerifyEmail || env().REQUIRE_EMAIL_VERIFICATION) && !user.emailVerifiedAt) {
    throw new AppError("EMAIL_NOT_VERIFIED", "Please verify your email address first. Open the link we emailed you, or send a new one.");
  }
  const token = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + env().SESSION_TTL_DAYS * 86_400_000);
  // Upgrade old cost-12 hashes once, so later logins are fast too.
  const userSet: Partial<UserDoc> = { lastLoginAt: now };
  if (needsRehash(user.passwordHash)) userSet.passwordHash = await hashPassword(input.password);
  await Promise.all([
    c.sessions.insertOne({
      _id: new ObjectId(),
      userId: user._id,
      tokenHash: hashToken(token),
      sessionVersion: user.sessionVersion,
      createdAt: now,
      expiresAt,
      lastUsedAt: now,
      userAgent: meta.userAgent,
      ip: meta.ip,
    }),
    c.users.updateOne({ _id: user._id }, { $set: userSet }),
  ]);
  return { token, expiresAt, user: publicUser(user) };
}

export async function logout(auth: AuthContext) {
  const c = await cols();
  await c.sessions.deleteOne({ _id: auth.session._id });
  return { ok: true };
}

export async function logoutAll(auth: AuthContext) {
  const c = await cols();
  await c.users.updateOne({ _id: auth.user._id }, { $inc: { sessionVersion: 1 } });
  await c.sessions.deleteMany({ userId: auth.user._id });
  return { ok: true };
}

export async function forgotPassword(emailAddr: string, ip: string) {
  await rateLimit(`forgot-ip:${ip}`, 10, 3600);
  await rateLimit(`forgot-email:${emailAddr}`, 3, 3600);
  const c = await cols();
  const user = await c.users.findOne({ email: emailAddr, status: "active" });
  if (user) {
    const token = await issueToken(user._id, "password_reset", 60);
    const link = `${env().FRONTEND_URL}/reset-password?token=${encodeURIComponent(token)}`;
    const mail = renderEmail({
      preheader: "Choose a new password for your MandalHisab account.",
      heading: "Reset your password",
      greeting: `Namaste ${user.name.split(" ")[0]},`,
      paragraphs: ["We got a request to reset the password for your MandalHisab account. Tap the button below to choose a new one."],
      button: { label: "Choose a new password", url: link },
      note: "This link expires in 1 hour and can be used once. If you didn't ask for this, ignore this email — your password stays the same.",
      reason: `You're receiving this because a password reset was requested for ${user.email}.`,
    });
    await sendEmail({ to: user.email, subject: "Reset your MandalHisab password", ...mail });
  }
  // Always the same response so emails cannot be enumerated.
  return { ok: true };
}

export async function resetPassword(token: string, password: string, ip: string) {
  await rateLimit(`reset:${ip}`, 20, 3600);
  const t = await consumeToken(token, "password_reset");
  const c = await cols();
  await c.users.updateOne(
    { _id: t.userId },
    { $set: { passwordHash: await hashPassword(password), updatedAt: new Date() }, $inc: { sessionVersion: 1 } },
  );
  await c.sessions.deleteMany({ userId: t.userId });
  await audit({ actorId: t.userId, action: "user.password_reset", entityType: "user", entityId: t.userId, ip });
  return { ok: true };
}

export async function changePassword(auth: AuthContext, current: string, next: string) {
  await rateLimit(`change-pw:${auth.user._id}`, 10, 3600);
  if (!(await verifyPassword(current, auth.user.passwordHash))) throw badRequest("Current password is incorrect");
  const c = await cols();
  await c.users.updateOne(
    { _id: auth.user._id },
    { $set: { passwordHash: await hashPassword(next), updatedAt: new Date() }, $inc: { sessionVersion: 1 } },
  );
  // Invalidate every other session; caller must log in again.
  await c.sessions.deleteMany({ userId: auth.user._id });
  return { ok: true };
}

export const ProfileSchema = z.object({ name: z.string().trim().min(2).max(100).optional(), phone });

export async function updateProfile(auth: AuthContext, input: z.infer<typeof ProfileSchema>) {
  const c = await cols();
  const $set: Partial<UserDoc> = { updatedAt: new Date() };
  if (input.name) $set.name = input.name;
  if (input.phone !== undefined) $set.phone = input.phone;
  const u = await c.users.findOneAndUpdate({ _id: auth.user._id }, { $set }, { returnDocument: "after" });
  return publicUser(u!);
}

/** Deactivate a user platform-wide: all sessions are invalidated immediately. */
export async function deactivateUser(actor: AuthContext, userId: ObjectId, reasonText: string) {
  const c = await cols();
  const before = await c.users.findOne({ _id: userId });
  if (!before) throw badRequest("User not found");
  await c.users.updateOne({ _id: userId }, { $set: { status: "deactivated", updatedAt: new Date() }, $inc: { sessionVersion: 1 } });
  await c.sessions.deleteMany({ userId });
  await audit({ actorId: actor.user._id, action: "user.deactivate", entityType: "user", entityId: userId, reason: reasonText });
}

export async function me(auth: AuthContext) {
  const c = await cols();
  // invitations waiting for this person (shown as a banner inside the app)
  const invitationsP = c.invitations
    .aggregate<{ _id: ObjectId; role: string; org: { _id: ObjectId; name: string; status: string }[]; inviter: { name: string }[] }>([
      { $match: { email: auth.user.email, status: "pending", expiresAt: { $gt: new Date() } } },
      { $sort: { createdAt: -1 } },
      { $limit: 5 },
      { $lookup: { from: "organizations", localField: "organizationId", foreignField: "_id", as: "org", pipeline: [{ $project: { name: 1, status: 1 } }] } },
      { $lookup: { from: "users", localField: "invitedBy", foreignField: "_id", as: "inviter", pipeline: [{ $project: { name: 1 } }] } },
      { $project: { role: 1, org: 1, inviter: 1 } },
    ])
    .toArray();
  const membershipsP = c.organizationMemberships
    .aggregate<{
      _id: ObjectId;
      role: string;
      status: string;
      memberId?: ObjectId;
      org: { _id: ObjectId; name: string; code: string; status: string; logoUrl?: string };
    }>([
      { $match: { userId: auth.user._id, status: { $in: ["active", "pending"] } } },
      { $lookup: { from: "organizations", localField: "organizationId", foreignField: "_id", as: "org" } },
      { $unwind: "$org" },
      {
        $project: {
          role: 1,
          status: 1,
          memberId: 1,
          "org._id": 1,
          "org.name": 1,
          "org.code": 1,
          "org.status": 1,
          "org.logoUrl": 1,
        },
      },
      { $sort: { "org.name": 1 } },
    ])
    .toArray();
  const [memberships, invitations] = await Promise.all([membershipsP, invitationsP]);
  return {
    user: publicUser(auth.user),
    organizations: memberships.map((m) => ({
      membershipId: m._id,
      role: m.role,
      membershipStatus: m.status,
      memberId: m.memberId ?? null,
      id: m.org._id,
      name: m.org.name,
      code: m.org.code,
      status: m.org.status,
      logoUrl: m.org.logoUrl ?? null,
    })),
    invitations: invitations
      .filter((i) => i.org[0] && i.org[0].status !== "suspended" && i.org[0].status !== "archived")
      .map((i) => ({ id: i._id, role: i.role, organization: { _id: i.org[0]._id, name: i.org[0].name }, invitedByName: i.inviter[0]?.name ?? null })),
  };
}
