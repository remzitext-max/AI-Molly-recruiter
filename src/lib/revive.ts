// Old leads ("revive"): drivers sitting in the lead sheets for weeks or months who never
// became drivers. Every row of every sheet tab is already kept in SheetRow; here each one
// is sorted into a segment (why it is stuck) or a reason it is left alone, and, for teams
// that switched it on, Crystal calls a few of them a day with a "we've got a good offer
// running now" opener. A recruiter's status change in the sheet always wins: a call is
// placed only while the sheet still shows the status the driver had when picked.
import type { SheetRow } from "@prisma/client";
import { db } from "./db";
import { config } from "./config";
import { enqueue } from "./jobs/queue";
import { ingestLead, scheduleLeadCall } from "./leads";
import { recordEvent } from "./activity";
import { isSuppressed } from "./contact-policy";
import { canonicalStatus } from "./recruiter-status";
import { phonesOfOtherOrgs } from "./sheets-sync";
import { assignFromSheetTabs } from "./assignment";
import { REVIVE_PREFIX } from "./new-leads";

const DAY = 86400_000;
export const REVIVE_CALLS = 2;
/** Older than this is too stale to call (numbers change, the ad was a year ago). */
export const REVIVE_MAX_DAYS = 365;

export const SEGMENTS = {
  quiet: { label: "Talked, then went quiet", hint: "Need to talk / Call back / Need teammate, nothing changed for 14+ days", statuses: ["Need to talk", "Call back", "Need teammate"], minDays: 14, talkedBefore: true },
  never: { label: "Never reached", hint: "New / No answer, applied 14+ days ago", statuses: ["New", "No answer"], minDays: 14, talkedBefore: false },
  no: { label: "Said no before", hint: "Not interested / Changed his mind, 45+ days ago", statuses: ["Not interested", "Changed his mind"], minDays: 45, talkedBefore: true },
} as const;
export type Segment = keyof typeof SEGMENTS;
export const SEGMENT_ORDER: Segment[] = ["quiet", "never", "no"];

/** Statuses Crystal never revives, with the reason shown on the page. */
const LEFT_ALONE: Record<string, string> = {
  "Need to bring": "In process with a recruiter", "Need approval": "In process with a recruiter", Application: "In process with a recruiter", Paired: "In process with a recruiter",
  Hired: "Hired / our driver", "Our driver – working": "Hired / our driver",
  SAP: "SAP", "Not qualified": "Not qualified", Declined: "Declined by safety", "Not in service": "Number not in service",
};
const LOW_EXPERIENCE = /less than|under 1|^\s*<\s*1|^\s*0\b|no experience|6 ?months?|just got/i;

export type Verdict = { segment: Segment } | { skip: string; later?: boolean };

/** Why a sheet row is stuck, or why Crystal leaves it alone. */
export function classifyRow(r: Pick<SheetRow, "status" | "appliedAt" | "statusAt" | "experience">, now = new Date()): Verdict {
  const status = canonicalStatus(r.status) ?? r.status;
  if (LEFT_ALONE[status]) return { skip: LEFT_ALONE[status] };
  if (r.experience && LOW_EXPERIENCE.test(r.experience)) return { skip: "Under 1 year experience" };
  const segment = SEGMENT_ORDER.find((s) => (SEGMENTS[s].statuses as readonly string[]).includes(status));
  if (!segment) return { skip: `Status "${r.status}"` };
  const applied = r.appliedAt?.getTime();
  if (applied && now.getTime() - applied > REVIVE_MAX_DAYS * DAY) return { skip: "Applied over a year ago" };
  // "Never reached" counts from the application; the others from when the status was set.
  const since = segment === "never" ? applied ?? r.statusAt?.getTime() : r.statusAt?.getTime() ?? applied;
  if (!since) return { skip: "No applied date" };
  if (now.getTime() - since < SEGMENTS[segment].minDays * DAY) return { skip: "Too recent", later: true };
  return { segment };
}

/** Lead-side reasons (opted out, called lately, already revived); null = may be called. */
async function leadBlock(orgId: string, phoneE164: string, now: Date): Promise<string | null> {
  if (await isSuppressed(phoneE164)) return "Opted out";
  const lead = await db.lead.findUnique({ where: { orgId_phoneE164: { orgId, phoneE164 } }, include: { calls: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } } } });
  if (!lead) return null;
  if (lead.isDemo) return "Demo record";
  if (lead.optedOutAt) return "Opted out";
  if (lead.ownDriver) return "Recruiter's own driver";
  if (lead.reviveAt) return "Already revived";
  if (lead.activeAttemptId) return "On a call now";
  if (["APPLICATION", "ORIENTATION", "HIRED"].includes(lead.hireStage)) return "In process with a recruiter";
  if (lead.reengagedAt && now.getTime() - lead.reengagedAt.getTime() < 30 * DAY) return "Had a follow-up round lately";
  const last = lead.calls[0]?.createdAt;
  if (last && now.getTime() - last.getTime() < 14 * DAY) return "Called in the last 14 days";
  if (await db.job.findFirst({ where: { type: "lead.attempt-call", status: { in: ["PENDING", "RUNNING"] }, payload: { path: ["leadId"], equals: lead.id } }, select: { id: true } })) return "Already queued";
  return null;
}

export interface ReviveSummary {
  orgId: string; total: number;
  segments: Record<Segment, { ready: number; later: number }>;
  skipped: { reason: string; n: number }[];
}

/** The old-leads page: how a team's sheet rows sort into segments today. */
export async function reviveSummary(orgId: string, now = new Date()): Promise<ReviveSummary> {
  const rows = await db.sheetRow.findMany({ where: { orgId } });
  const segments = Object.fromEntries(SEGMENT_ORDER.map((s) => [s, { ready: 0, later: 0 }])) as ReviveSummary["segments"];
  const skipped = new Map<string, number>();
  const ready: { row: SheetRow; segment: Segment }[] = [];
  for (const row of rows) {
    const v = classifyRow(row, now);
    if ("segment" in v) ready.push({ row, segment: v.segment });
    else if (v.later) { const s = SEGMENT_ORDER.find((k) => (SEGMENTS[k].statuses as readonly string[]).includes(canonicalStatus(row.status) ?? row.status)); if (s) segments[s].later++; }
    else skipped.set(v.skip, (skipped.get(v.skip) ?? 0) + 1);
  }
  // Lead-side checks for the rows that pass the sheet rules (one query per row; a few hundred at most).
  const elsewhere = await phonesOfOtherOrgs(orgId, ready.map((r) => r.row.phoneE164));
  for (const { row, segment } of ready) {
    const block = elsewhere.has(row.phoneE164) ? "Another team's driver" : await leadBlock(orgId, row.phoneE164, now);
    if (block) skipped.set(block, (skipped.get(block) ?? 0) + 1);
    else segments[segment].ready++;
  }
  return { orgId, total: rows.length, segments, skipped: [...skipped].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n) };
}

/** Results of the drivers revived so far (or since a date). */
export async function reviveResults(orgId: string, since?: Date) {
  const leads = await db.lead.findMany({
    where: { orgId, isDemo: false, reviveAt: since ? { gte: since } : { not: null } },
    select: { reviveAt: true, reviveFrom: true, hireStage: true, hiredAt: true,
      calls: { where: { status: "COMPLETED" }, select: { createdAt: true, outcome: true } },
      documents: { select: { uploadedAt: true } } },
  });
  // Only what happened after the driver was picked: their old calls and documents do not count.
  const after = (l: (typeof leads)[number], d: Date) => !!l.reviveAt && d >= l.reviveAt;
  const row = (ls: typeof leads) => ({
    picked: ls.length,
    talked: ls.filter((l) => l.calls.some((c) => after(l, c.createdAt) && ["INTERESTED", "NOT_INTERESTED", "CALLBACK", "HUMAN_REQUESTED"].includes(c.outcome ?? ""))).length,
    interested: ls.filter((l) => l.calls.some((c) => after(l, c.createdAt) && c.outcome === "INTERESTED")).length,
    docs: ls.filter((l) => l.documents.some((d) => after(l, d.uploadedAt))).length,
    hired: ls.filter((l) => l.hireStage === "HIRED" && !!l.hiredAt && after(l, l.hiredAt)).length,
  });
  const bySegment = Object.fromEntries(SEGMENT_ORDER.map((s) => [s, row(leads.filter((l) => segmentOfStatus(l.reviveFrom) === s))])) as Record<Segment, ReturnType<typeof row>>;
  return { all: row(leads), bySegment };
}

export function segmentOfStatus(status: string | null | undefined): Segment | null {
  const s = canonicalStatus(status) ?? status ?? "";
  return SEGMENT_ORDER.find((k) => (SEGMENTS[k].statuses as readonly string[]).includes(s)) ?? null;
}

/** May Crystal call this revived lead now? Only while the sheet still shows the status it was picked with. */
export async function reviveStillOpen(lead: { orgId: string; phoneE164: string; reviveFrom: string | null; hireStage: string }) {
  if (!lead.reviveFrom || ["APPLICATION", "ORIENTATION", "HIRED"].includes(lead.hireStage)) return false;
  const row = await db.sheetRow.findUnique({ where: { orgId_phoneE164: { orgId: lead.orgId, phoneE164: lead.phoneE164 } } });
  return !!row && (canonicalStatus(row.status) ?? row.status) === (canonicalStatus(lead.reviveFrom) ?? lead.reviveFrom);
}

/** Picks today's old leads for every team that switched revive on and queues Crystal's calls. */
export async function reviveScan(now = new Date()) {
  const campaigns = await db.campaign.findMany({ where: { reviveEnabled: true, paused: false, isDemo: false, revivePerDay: { gt: 0 } }, orderBy: { createdAt: "asc" } });
  let queued = 0;
  const seenOrg = new Set<string>();
  for (const c of campaigns) {
    if (seenOrg.has(c.orgId)) continue; // one campaign per team picks
    seenOrg.add(c.orgId);
    const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
    let room = c.revivePerDay - (await db.lead.count({ where: { orgId: c.orgId, reviveAt: { gte: dayStart } } }));
    if (room <= 0) continue;
    const rows = await db.sheetRow.findMany({ where: { orgId: c.orgId } });
    const picks = rows
      .map((row) => ({ row, v: classifyRow(row, now) }))
      .filter((p): p is { row: SheetRow; v: { segment: Segment } } => "segment" in p.v)
      .sort((a, b) => SEGMENT_ORDER.indexOf(a.v.segment) - SEGMENT_ORDER.indexOf(b.v.segment) || (b.row.appliedAt?.getTime() ?? 0) - (a.row.appliedAt?.getTime() ?? 0));
    const elsewhere = await phonesOfOtherOrgs(c.orgId, picks.map((p) => p.row.phoneE164));
    for (const { row, v } of picks) {
      if (room <= 0) break;
      if (elsewhere.has(row.phoneE164) || (await leadBlock(c.orgId, row.phoneE164, now))) continue;
      const [first, ...rest] = (row.name ?? "").trim().split(/\s+/);
      const r = await ingestLead(
        { sourceSystem: "REVIVE", sourceRecordId: `${REVIVE_PREFIX}${c.orgId}:${row.phoneE164}`, firstName: first || undefined, lastName: rest.join(" ") || undefined, phone: row.phoneE164,
          permission: [{ scope: "AI_CALL", source: `Facebook lead form (old lead in sheet tab ${row.tab})`, grantedAt: (row.appliedAt ?? now).toISOString() }],
          raw: { tab: row.tab, status: row.status, applied: row.appliedAt?.toISOString() ?? null, revive: v.segment } },
        { orgId: c.orgId, campaignId: c.id, isDemo: false, actorId: null, scheduleOutreach: false },
      );
      if (!("leadId" in r) || !r.leadId) continue;
      const lead = await db.lead.findUniqueOrThrow({ where: { id: r.leadId } });
      await db.lead.update({
        where: { id: lead.id },
        data: {
          reviveAt: now, reviveFrom: canonicalStatus(row.status) ?? row.status, reviveTab: row.tab, reengagedAt: now,
          attemptCount: Math.max(0, c.maxAttempts - REVIVE_CALLS),
          ...(["NEW", "QUEUED", "CONTACTING", "NOT_INTERESTED", "CLOSED"].includes(lead.pipelineStatus) ? { pipelineStatus: "QUEUED" as const } : {}),
          queueReason: `Old lead: ${SEGMENTS[v.segment].label.toLowerCase()} (sheet ${row.tab}: ${row.status})`,
        },
      });
      // The recruiter whose tab the driver sits in gets the result (the Pool has no owner).
      if (!/pool/i.test(row.tab)) await assignFromSheetTabs([{ phoneE164: row.phoneE164, tab: row.tab }]);
      await recordEvent({ leadId: lead.id, actorType: "SYSTEM", type: "REVIVE", message: `Old lead picked for Crystal: ${SEGMENTS[v.segment].label} (sheet ${row.tab} tab: ${row.status}); up to ${REVIVE_CALLS} calls` });
      await scheduleLeadCall(lead.id, { at: now, reason: `Old lead (${SEGMENTS[v.segment].label})` });
      queued++; room--;
    }
  }
  return { queued };
}

export async function scheduleReviveScan(now = Date.now()) {
  if (config.mode !== "live") return;
  await enqueue("lead.revive-scan", {}, { idempotencyKey: `revive:${Math.floor(now / 3600_000)}`, maxAttempts: 1 });
}
