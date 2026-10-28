import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "./db";
import { randomToken, sha256 } from "./crypto";
import type { User } from "@prisma/client";

export const SESSION_COOKIE = "molly_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export async function hashPassword(pw: string) {
  return bcrypt.hash(pw, 12);
}

export async function verifyLogin(email: string, password: string): Promise<User | null> {
  const user = await db.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  // Always run a comparison to keep timing similar for unknown emails.
  const ok = await bcrypt.compare(password, user?.passwordHash ?? "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva");
  if (!user || !ok || !user.active) return null;
  return user;
}

export async function createSession(userId: string) {
  const token = randomToken();
  await db.session.create({ data: { userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + SESSION_TTL_MS) } });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.session.deleteMany({ where: { tokenHash: sha256(token) } });
  jar.delete(SESSION_COOKIE);
}

export async function userFromToken(token: string | undefined | null): Promise<User | null> {
  if (!token) return null;
  const s = await db.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!s || s.expiresAt < new Date() || !s.user.active) return null;
  return s.user;
}

export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  return userFromToken(jar.get(SESSION_COOKIE)?.value);
}

/** For pages: redirect to login when unauthenticated. */
export async function requireUser(): Promise<User> {
  const u = await currentUser();
  if (!u) redirect("/login");
  return u;
}

export async function requireAdmin(): Promise<User> {
  const u = await requireUser();
  if (u.role !== "ADMIN") redirect("/dashboard?error=forbidden");
  return u;
}

/** The owner's company admins (Settings, Voice, Ads, Jobs...); a team's manager is an admin of their team only. */
export async function isOwner(u: Pick<User, "role" | "orgId">) {
  if (u.role !== "ADMIN") return false;
  return !!(await db.organization.findUnique({ where: { id: u.orgId }, select: { isMain: true } }))?.isMain;
}

export async function requireOwner(): Promise<User> {
  const u = await requireAdmin();
  if (!(await isOwner(u))) redirect("/dashboard?error=forbidden");
  return u;
}
