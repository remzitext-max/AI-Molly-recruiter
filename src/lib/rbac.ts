import type { Prisma, User } from "@prisma/client";
import { db } from "./db";

export class ForbiddenError extends Error {
  status = 403;
  constructor(msg = "Forbidden") { super(msg); }
}

/**
 * Prisma filter restricting leads to what this user may see: every lead of the company,
 * for recruiters too (the team shares one lead sheet, so any recruiter may pick up any
 * driver). Admin-only pages (Settings, Users, Facebook ads) stay admin-only.
 */
export function leadScope(user: Pick<User, "id" | "role" | "orgId">): Prisma.LeadWhereInput {
  return { orgId: user.orgId };
}

export async function canAccessLead(user: Pick<User, "id" | "role" | "orgId">, leadId: string) {
  const lead = await db.lead.findFirst({ where: { id: leadId, ...leadScope(user) }, select: { id: true } });
  return !!lead;
}

export async function assertLeadAccess(user: Pick<User, "id" | "role" | "orgId">, leadId: string) {
  if (!(await canAccessLead(user, leadId))) throw new ForbiddenError("No access to this candidate");
}

export function assertAdmin(user: Pick<User, "role">) {
  if (user.role !== "ADMIN") throw new ForbiddenError("Admin only");
}
