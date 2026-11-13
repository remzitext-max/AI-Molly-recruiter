// The driver lists behind the dashboard's Results cards: new leads (talked to Crystal or not,
// reached by a recruiter or not), "No answer" re-calls and old leads, each with what happened.
import type { CallStatus, Prisma } from "@prisma/client";
import type { ListItem } from "@/components/list-stat";
import { isReachedStatus } from "./sheet-rows";
import { crystalResult } from "./talked";

export const LEAD_SEL = {
  id: true, orgId: true, firstName: true, lastName: true, phoneE164: true, recruiterStatus: true,
  assignedTo: { select: { name: true } },
  calls: { where: { status: { notIn: ["CANCELED", "SCHEDULED"] as CallStatus[] } }, orderBy: { createdAt: "asc" as const }, select: { id: true, createdAt: true, status: true, outcome: true } },
} satisfies Prisma.LeadSelect;

type Call = { id: string; createdAt: Date; status: string; outcome: string | null };
export type ListLead = { id: string; orgId: string; firstName: string | null; lastName: string | null; phoneE164: string; recruiterStatus: string | null; assignedTo: { name: string } | null; calls: Call[] };

const nameOf = (l: { firstName: string | null; lastName: string | null }) => [l.firstName, l.lastName].filter(Boolean).join(" ") || "(no name)";

/**
 * One lead as a list row; `since` keeps only the calls after the driver was picked. The
 * recruiter and status come from the lead sheet when the driver is in a recruiter's tab
 * (`sheet`): that is who works the driver, while the site's round-robin owner may be
 * someone else. The row reads "recruiter · Crystal: what she got", the badge is the sheet status.
 */
export function leadRow(l: ListLead, gaveAnswers: Set<string>, team: string | null, opts: { since?: Date; was?: string; note?: string; sheet?: { recruiter: string; status: string } } = {}) {
  const r = crystalResult(opts.since ? l.calls.filter((c) => c.createdAt >= opts.since!) : l.calls, gaveAnswers);
  const item: ListItem = {
    key: l.id, leadId: l.id, name: nameOf(l), phone: l.phoneE164,
    sub: [team, opts.sheet?.recruiter ?? l.assignedTo?.name ?? "no recruiter yet", opts.was ? `was ${opts.was}` : null, opts.note ?? null, `Crystal: ${r.text}`].filter(Boolean).join(" · "),
    badge: opts.sheet?.status ?? l.recruiterStatus ?? undefined,
    tone: r.talked ? "ok" : r.calls ? "warn" : "late",
  };
  return { talked: r.talked, interested: r.interested, item };
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
