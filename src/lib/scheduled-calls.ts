// Calls a recruiter has to make at a booked time (Crystal books them when a driver asks for
// a person after office hours). They stay on the recruiter's dashboard until the recruiter
// marks the call made.
import type { User } from "@prisma/client";
import { db } from "./db";
import { recordEvent } from "./activity";
import { assertLeadAccess } from "./rbac";

export const RECRUITER_CALL_KEY = "recruiter-call:";
const AHEAD_MS = 24 * 3600_000;

/** Open booked calls due within the next 24 hours (and every missed one), soonest first. */
export async function scheduledCalls(user: Pick<User, "id" | "role" | "orgId">, now = new Date(), orgIds?: string[]) {
  const mine = user.role === "ADMIN" ? {} : { OR: [{ assignedToId: user.id }, { lead: { assignedToId: user.id } }] };
  return db.task.findMany({
    where: {
      status: "OPEN", type: "CALLBACK", dedupeKey: { startsWith: RECRUITER_CALL_KEY }, dueAt: { not: null, lte: new Date(now.getTime() + AHEAD_MS) },
      lead: { orgId: { in: orgIds ?? [user.orgId] }, optedOutAt: null }, ...mine,
    },
    include: { lead: { select: { id: true, firstName: true, lastName: true, phoneE164: true, timezone: true, assignedTo: { select: { name: true } } } } },
    orderBy: { dueAt: "asc" },
  });
}

/** Open booked calls per recruiter (lead's recruiter), and how many of them are already late. */
export async function scheduledByRecruiter(orgIds: string[], now = new Date()) {
  const open = await db.task.findMany({
    where: { status: "OPEN", type: "CALLBACK", dedupeKey: { startsWith: RECRUITER_CALL_KEY }, dueAt: { not: null }, lead: { orgId: { in: orgIds }, optedOutAt: null } },
    select: { dueAt: true, assignedToId: true, lead: { select: { assignedToId: true } } },
  });
  const by = new Map<string, { open: number; late: number }>();
  for (const t of open) {
    const k = t.lead.assignedToId ?? t.assignedToId ?? "none";
    const r = by.get(k) ?? { open: 0, late: 0 };
    r.open++;
    if (t.dueAt! < now) r.late++;
    by.set(k, r);
  }
  return by;
}

/** The recruiter called the driver: the booking leaves the dashboard. */
export async function markCallMade(user: Pick<User, "id" | "role" | "orgId" | "name">, taskId: string, now = new Date()) {
  const t = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  await assertLeadAccess(user, t.leadId);
  if (t.status !== "OPEN") return;
  await db.task.update({ where: { id: t.id }, data: { status: "DONE", completedAt: now } });
  await db.lead.updateMany({ where: { id: t.leadId, recruiterCallAt: { not: null, lte: new Date(now.getTime() + AHEAD_MS) } }, data: { recruiterCallAt: null } });
  await recordEvent({ leadId: t.leadId, actorType: "USER", actorId: user.id, type: "TASK_DONE", message: `Booked call made by ${user.name}` });
}
