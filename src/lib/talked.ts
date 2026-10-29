// Which calls were a real conversation with the driver, and the drivers Crystal really
// talked to in a period with where each one is now. Used by the dashboard and the
// "Drivers talked to" list so both always count the same drivers.
import type { Prisma, User } from "@prisma/client";
import { db } from "./db";
import { leadScope } from "./rbac";
import { UPLOAD_PROVIDER } from "./recruiter-upload";

// Owner test calls (scripts/telnyx-test-call.ts, "Remzi Test" sheet rows) are not real results.
const TEST_LAST_NAMES = ["(owner test)", "Test", "test", "TEST"];
const OWNER_PHONES = ["+18162913808", "+18158461661"];

/**
 * Leads the dashboard counts: no owner tests, no recruiters' own drivers (Create form).
 * `mine` limits it to the user's assigned leads.
 */
export function dashboardScope(user: Pick<User, "id" | "role" | "orgId">, mine: boolean, isDemo: boolean): Prisma.LeadWhereInput {
  return {
    ...leadScope(user), isDemo, ownDriver: false, phoneE164: { notIn: OWNER_PHONES }, OR: [{ lastName: null }, { lastName: { notIn: TEST_LAST_NAMES } }],
    ...(mine ? { assignedToId: user.id } : {}),
  };
}

/** Outcomes that are a decision the driver made in the call. */
export const DECIDED = ["INTERESTED", "NOT_INTERESTED", "CALLBACK", "HUMAN_REQUESTED"];

/**
 * Ids of the calls in which the driver answered a screening question. Saying "yes" to
 * "Is this John?" (first name) or Crystal's English rating does not count: the driver
 * may have hung up right after.
 */
export async function callsWithAnswers(ids: string[]) {
  const rows = await db.screeningField.findMany({ where: { callAttemptId: { in: ids }, key: { notIn: ["english_level", "first_name"] }, reportedValue: { not: null } }, select: { callAttemptId: true }, distinct: ["callAttemptId"] });
  return new Set(rows.map((r) => r.callAttemptId!));
}

/** A real conversation: the call connected and the driver answered a question or made a decision. */
export function isTalk(c: { id: string; status?: string; outcome: string | null }, gaveAnswers: Set<string>) {
  return (c.status ?? "COMPLETED") === "COMPLETED" && (DECIDED.includes(c.outcome ?? "") || gaveAnswers.has(c.id));
}

const CRYSTAL_RESULT: Record<string, string> = {
  INTERESTED: "Interested (Crystal's call)",
  NOT_INTERESTED: "Not interested (Crystal's call)",
  CALLBACK: "Asked to call back",
  HUMAN_REQUESTED: "Asked for a person",
};
export const NO_CLEAR_ANSWER = "Talked, no clear yes or no";

export interface TalkedDriver {
  leadId: string; name: string; phone: string; recruiter: string | null; lastTalk: Date;
  /** Where the driver is now: the recruiter's status, else what they said to Crystal. */
  group: string; crystal: string; recruiterStatus: string | null;
}

/** Drivers Crystal really talked to in the period, newest talk first. */
export async function talkedDrivers(scope: Prisma.LeadWhereInput, range: { gte: Date; lt: Date }): Promise<TalkedDriver[]> {
  const calls = await db.callAttempt.findMany({
    where: { lead: scope, provider: { not: UPLOAD_PROVIDER }, status: "COMPLETED", createdAt: range },
    orderBy: { createdAt: "desc" }, select: { id: true, leadId: true, outcome: true, createdAt: true },
  });
  const gave = await callsWithAnswers(calls.map((c) => c.id));
  const last = new Map<string, (typeof calls)[number]>(); // newest real talk per driver
  const decided = new Map<string, string>(); // newest decision per driver
  for (const c of calls) {
    if (!isTalk(c, gave)) continue;
    if (!last.has(c.leadId)) last.set(c.leadId, c);
    if (DECIDED.includes(c.outcome ?? "") && !decided.has(c.leadId)) decided.set(c.leadId, c.outcome!);
  }
  const leads = await db.lead.findMany({
    where: { id: { in: [...last.keys()] } },
    select: { id: true, firstName: true, lastName: true, phoneE164: true, recruiterStatus: true, assignedTo: { select: { name: true } } },
  });
  return leads.map((l) => {
    const crystal = CRYSTAL_RESULT[decided.get(l.id) ?? ""] ?? NO_CLEAR_ANSWER;
    return {
      leadId: l.id, name: [l.firstName, l.lastName].filter(Boolean).join(" ") || "(no name)", phone: l.phoneE164,
      recruiter: l.assignedTo?.name ?? null, lastTalk: last.get(l.id)!.createdAt,
      group: l.recruiterStatus ?? crystal, crystal, recruiterStatus: l.recruiterStatus,
    };
  }).sort((a, b) => b.lastTalk.getTime() - a.lastTalk.getTime());
}

/** Count per group, biggest first. */
export function groupCounts(list: TalkedDriver[]) {
  const m = new Map<string, number>();
  for (const d of list) m.set(d.group, (m.get(d.group) ?? 0) + 1);
  return [...m].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);
}
