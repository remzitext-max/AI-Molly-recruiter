// The driver lists behind the dashboard's Results cards: new leads (talked to Crystal or not,
// reached by a recruiter or not), "No answer" re-calls and old leads, each with what happened.
import type { ListItem } from "@/components/list-stat";
import { LEAD_SEL, crystalResult } from "./talked";
import { reachedByRecruiter, type NewLead, type NotCrystal } from "./sheet-applications";

export { LEAD_SEL };

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

const NOT_CRYSTAL: Record<NotCrystal, string> = {
  straight: "straight to the recruiter",
  other_team: "another team's driver first",
  again: "applied again, Crystal already had this driver",
  before: "applied before Crystal started",
  pool: "in the Pool, not taken by Crystal",
  no_phone: "no valid phone number",
};

/**
 * One new lead (a sheet row that applied in the period) as a list row. `recruiter` is whose
 * sheet tab the row is in. Crystal's numbers count only the leads she got as new (the rows
 * that came through the Pool): a row the distributor put straight into a recruiter's tab is
 * a new lead of that day too, but not one she could call, and the row says why. `item` is the
 * row for Crystal's lists, `sheetItem` the same driver for the recruiters' lists (reached or not).
 */
export function newLeadRow(n: NewLead, gaveAnswers: Set<string>, team: string | null, recruiter: string | null) {
  // For a driver the site already had, only the calls after this application say anything about it.
  const calls = !n.lead ? [] : n.crystal ? n.lead.calls : n.lead.calls.filter((c) => c.createdAt >= n.appliedAt);
  const r = crystalResult(calls, gaveAnswers);
  const reached = reachedByRecruiter(n);
  const who = recruiter ?? n.lead?.assignedTo?.name ?? "no recruiter yet";
  const base = { key: n.key, leadId: n.lead?.id ?? null, name: n.name || (n.lead ? nameOf(n.lead) : "(no name)"), phone: n.phoneE164 ?? "", badge: n.status ?? n.lead?.recruiterStatus ?? undefined };
  const why = n.why ?? "straight";
  const crystal = n.crystal ? `Crystal: ${r.text}` : `${NOT_CRYSTAL[why]}${r.calls ? ` · Crystal later: ${r.text}` : why === "straight" ? ", not through Crystal" : ""}`;
  const item: ListItem = { ...base, sub: [team, who, crystal].filter(Boolean).join(" · "), tone: n.crystal ? (r.talked ? "ok" : r.calls ? "warn" : "late") : reached ? "ok" : "warn" };
  const sheetItem: ListItem = { ...base, sub: [team, who].filter(Boolean).join(" · "), tone: reached ? "ok" : "warn" };
  return { n, item, sheetItem, crystal: n.crystal, called: n.crystal && r.calls > 0, talked: n.crystal && r.talked, interested: n.crystal && r.interested, reached };
}
