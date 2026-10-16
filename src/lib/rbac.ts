import type { Prisma, User } from "@prisma/client";
import { db } from "./db";

export class ForbiddenError extends Error {
  status = 403;
  constructor(msg = "Forbidden") { super(msg); }
}

/** Prisma filter restricting leads to what this user may see. */
export function leadScope(user: Pick<User, "id" | "role" | "orgId">): Prisma.LeadWhereInput {
  if (user.role === "ADMIN") return { orgId: user.orgId };
  return { orgId: user.orgId, assignedToId: user.id };
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
