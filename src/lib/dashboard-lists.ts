// The driver lists behind the dashboard's Results cards: new leads (talked to Crystal or not,
// reached by a recruiter or not), "No answer" re-calls and old leads, each with what happened.
import type { CallStatus, Prisma } from "@prisma/client";
import type { ListItem } from "@/components/list-stat";
import { isReachedStatus } from "./sheet-rows";

export const LEAD_SEL = {
  id: true, orgId: true, firstName: true, lastName: true, phoneE164: true, recruiterStatus: true,
  assignedTo: { select: { name: true } },
  calls: { where: { status: { notIn: ["CANCELED", "SCHEDULED"] as CallStatus[] } }, orderBy: { createdAt: "asc" as const }, select: { id: true, createdAt: true, status: true, outcome: true } },
} satisfies Prisma.LeadSelect;

type Call = { id: string; createdAt: Date; status: string; outcome: string | null };
export type ListLead = { id: string; orgId: string; firstName: string | null; lastName: string | null; phoneE164: string; recruiterStatus: string | null; assignedTo: { name: string } | null; calls: Call[] };
type Talked = (c: Call) => boolean;

const RESULT: Record<string, string> = {
  INTERESTED: "Interested", NOT_INTERESTED: "Not interested", CALLBACK: "Call back", HUMAN_REQUESTED: "Wants a recruiter",
  OPT_OUT: "Asked not to call", WRONG_NUMBER: "Wrong number",
};
const nameOf = (l: { firstName: string | null; lastName: string | null }) => [l.firstName, l.lastName].filter(Boolean).join(" ") || "(no name)";

/** What Crystal got from these calls: the newest talk's result, or how many went unanswered. */
export function crystalResult(calls: Call[], talked: Talked): { talked: boolean; interested: boolean; text: string } {
  const talks = calls.filter(talked);
  const interested = calls.some((c) => c.outcome === "INTERESTED");
  if (talks.length) {
    const last = talks[talks.length - 1];
    return { talked: true, interested, text: interested ? "Interested" : RESULT[last.outcome ?? ""] ?? "Talked" };
  }
  return { talked: false, interested: false, text: calls.length ? `No answer · ${calls.length} call${calls.length === 1 ? "" : "s"}` : "Not called yet" };
}

/** One lead as a list row; `since` keeps only the calls after the driver was picked. */
export function leadRow(l: ListLead, talked: Talked, team: string | null, opts: { since?: Date; was?: string } = {}) {
  const calls = opts.since ? l.calls.filter((c) => c.createdAt >= opts.since!) : l.calls;
  const r = crystalResult(calls, talked);
  const item: ListItem = {
    key: l.id, leadId: l.id, name: nameOf(l), phone: l.phoneE164,
    sub: [team, l.assignedTo?.name ?? "no recruiter", opts.was ? `was ${opts.was}` : null, r.text].filter(Boolean).join(" · "),
    badge: l.recruiterStatus ?? undefined,
    tone: r.talked ? "ok" : calls.length ? "warn" : "late",
  };
  return { ...r, item };
}

/** Sheet rows (drivers who applied in the period) as list rows, reached by a recruiter or not. */
export function sheetRowItems(
  rows: { id: string; orgId: string; phoneE164: string; tab: string; status: string; name: string | null }[],
  leads: { id: string; orgId: string; phoneE164: string; firstName: string | null; lastName: string | null }[],
  recruiterOf: (orgId: string, tab: string) => string | null, teamOf: (orgId: string) => string | null,
) {
  const lead = new Map(leads.map((l) => [`${l.orgId}|${l.phoneE164}`, l]));
  return rows.map((r) => {
    const l = lead.get(`${r.orgId}|${r.phoneE164}`);
    const reached = isReachedStatus(r.status);
    const item: ListItem = {
      key: r.id, leadId: l?.id ?? null, name: r.name || (l ? nameOf(l) : "(no name)"), phone: r.phoneE164,
      sub: [teamOf(r.orgId), recruiterOf(r.orgId, r.tab) ?? (/pool/i.test(r.tab) ? "Pool" : r.tab)].filter(Boolean).join(" · "),
      badge: r.status, tone: reached ? "ok" : "warn",
    };
    return { reached, item };
  });
}
