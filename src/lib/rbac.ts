import type { Prisma, User } from "@prisma/client";
import { db } from "./db";

export class ForbiddenError extends Error {
  status = 403;
  constructor(msg = "Forbidden") { super(msg); }
}

/**
 * Prisma filter restricting leads to what this user may see: a manager sees every lead of
 * their team, a recruiter only the drivers assigned to them (their sheet tab), so nobody
 * else's leads get in the way. Admin-only pages (Settings, Users, Facebook ads) stay admin-only.
 */
export function leadScope(user: Pick<User, "id" | "role" | "orgId">): Prisma.LeadWhereInput {
  return user.role === "ADMIN" ? { orgId: user.orgId } : { orgId: user.orgId, assignedToId: user.id };
}

/**
 * What a user may open and read: the owner (an admin of the main company) every team's
 * leads, so the all-teams dashboards, Board and search open any driver; others leadScope.
 */
export async function readScope(user: Pick<User, "id" | "role" | "orgId">): Promise<Prisma.LeadWhereInput> {
  if (user.role === "ADMIN" && (await db.organization.findUnique({ where: { id: user.orgId }, select: { isMain: true } }))?.isMain) return {};
  return leadScope(user);
}

export async function canAccessLead(user: Pick<User, "id" | "role" | "orgId">, leadId: string) {
  const lead = await db.lead.findFirst({ where: { id: leadId, ...(await readScope(user)) }, select: { id: true } });
  return !!lead;
}

export async function assertLeadAccess(user: Pick<User, "id" | "role" | "orgId">, leadId: string) {
  if (!(await canAccessLead(user, leadId))) throw new ForbiddenError("No access to this candidate");
}

export function assertAdmin(user: Pick<User, "role">) {
  if (user.role !== "ADMIN") throw new ForbiddenError("Admin only");
}
