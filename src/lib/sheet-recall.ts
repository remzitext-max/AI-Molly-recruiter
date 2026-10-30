// Drivers the recruiters marked "No answer" in their sheet tabs, who applied
// between the campaign's recallMinDays and recallMaxDays ago and were never in
// Crystal's list, get up to 2 follow-up calls from Crystal ("following up on your
// application"). A few per day, newest first; the sheet status is checked again
// right before each call (see attemptCallJob). The main sheet uses the main
// campaign; each recruiting team's sheet uses the team's own campaign.
import { db } from "./db";
import { config } from "./config";
import { buildPreview, guessMapping, type Mapping } from "./import";
import { ingestLead, scheduleLeadCall } from "./leads";
import { normalizePhone } from "./phone";
import { phonesOfOtherOrgs, sheetMapping, tabSource, SHEETS_CONN_ID } from "./sheets-sync";
import type { SheetSnapshot } from "../adapters/types";

export type SheetTab = { title: string; gid: string; snap: SheetSnapshot };

/** Whose sheet it is: the org and campaign the re-called drivers become leads of. */
export interface RecallTarget { orgId: string; campaignId: string; mapping: (headers: string[]) => Mapping; source: (gid: string) => string }

const NO_ANSWER = /^(no answer|no response)$/i;
const NOT_WORKED = /^(|no answer|no response|new)$/i;
const FOLLOW_UP_CALLS = 2;
export const RECALL_PREFIX = "recall:";

/** The main lead sheet's target: its saved mapping and campaign. */
async function mainTarget(): Promise<RecallTarget | null> {
  const conn = await db.sourceConnection.findUnique({ where: { id: SHEETS_CONN_ID } });
  if (!conn?.campaignId || !conn.mapping) return null;
  const saved = conn.mapping as Mapping;
  return { orgId: conn.orgId, campaignId: conn.campaignId, mapping: (h) => sheetMapping(h, saved), source: tabSource };
}

/** A team sheet's target: the main sheet's mapping where the headers match, a guess for the rest. */
export function teamTarget(orgId: string, campaignId: string, source: (gid: string) => string, main: Mapping | null): RecallTarget {
  return { orgId, campaignId, source, mapping: (h) => {
    const m = sheetMapping(h, { ...guessMapping(h), ...(main ?? {}) });
    if (m.sourceRecordId && !h.includes(m.sourceRecordId)) delete m.sourceRecordId;
    return m;
  } };
}

export async function recallNoAnswerLeads(tabs: SheetTab[], now = new Date(), target?: RecallTarget | null) {
  if (config.mode !== "live") return 0;
  const t = target === undefined ? await mainTarget() : target;
  if (!t) return 0;
  const campaign = await db.campaign.findUnique({ where: { id: t.campaignId } });
  if (!campaign || campaign.paused || campaign.recallMinDays <= 0 || campaign.isDemo) return 0;

  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const today = await db.leadSourceRecord.count({ where: { sourceRecordId: { startsWith: RECALL_PREFIX }, createdAt: { gte: dayStart }, lead: { orgId: t.orgId } } });
  let room = campaign.recallPerDay - today;
  if (room <= 0) return 0;

  const from = now.getTime() - campaign.recallMaxDays * 86400_000, to = now.getTime() - campaign.recallMinDays * 86400_000;
  const picks: { tab: SheetTab; row: string[]; applied: Date }[] = [];
  // A phone a recruiter has worked in any tab of this sheet ("Call back", "Not interested"...).
  const worked = new Set<string>();
  for (const tab of tabs) {
    const h = tab.snap.headers;
    const statusI = h.findIndex((x) => /^status$/i.test(x)), appliedI = h.findIndex((x) => /^applied/i.test(x)), phoneI = h.findIndex((x) => /^phone$/i.test(x));
    if (statusI < 0) continue;
    for (const row of tab.snap.rows) {
      const status = (row[statusI] ?? "").trim();
      if (!NOT_WORKED.test(status)) { const p = phoneI >= 0 && normalizePhone(row[phoneI] ?? ""); if (p) worked.add(p); }
      if (appliedI < 0 || !NO_ANSWER.test(status)) continue;
      const applied = new Date(row[appliedI] ?? "");
      if (isNaN(applied.getTime()) || applied.getTime() < from || applied.getTime() > to) continue;
      picks.push({ tab, row, applied });
    }
  }
  picks.sort((a, b) => b.applied.getTime() - a.applied.getTime());

  let recalled = 0;
  for (const p of picks) {
    if (room <= 0) break;
    const { headers } = p.tab.snap;
    const [row] = await buildPreview({ headers, rows: [p.row], warnings: [] }, t.mapping(headers), t.source(p.tab.gid), t.orgId);
    // Only drivers Crystal never had: everyone else is covered by the 30-day follow-up.
    if (!row || row.disposition !== "new" || !row.phoneE164 || worked.has(row.phoneE164)) continue;
    // The same phone in another tab with a recruiter's status: they have talked.
    const st = await db.sheetLeadStatus.findUnique({ where: { phoneE164: row.phoneE164 } });
    if (st && st.status && !NO_ANSWER.test(st.status)) continue;
    // Another team's (or the company's own) driver is never called by this sheet.
    if ((await phonesOfOtherOrgs(t.orgId, [row.phoneE164])).size) continue;
    const v = row.values;
    const r = await ingestLead(
      { sourceSystem: t.source(p.tab.gid), sourceRecordId: `${RECALL_PREFIX}${row.sourceRecordId}`, firstName: v.firstName, lastName: v.lastName, phone: v.phone, email: v.email, state: v.state, zip: v.zip,
        permission: [{ scope: "AI_CALL", source: `Facebook lead form (applied date from sheet tab ${p.tab.title})`, grantedAt: p.applied.toISOString() }],
        raw: { tab: p.tab.title, status: "No answer", applied: p.applied.toISOString(), recall: true, ...(v.position ? { position: v.position } : {}) } },
      { orgId: t.orgId, campaignId: campaign.id, isDemo: false, actorId: null, scheduleOutreach: false },
    );
    if (r.result !== "created") continue;
    await db.lead.update({ where: { id: r.leadId }, data: { reengagedAt: now, attemptCount: Math.max(0, campaign.maxAttempts - FOLLOW_UP_CALLS) } });
    await scheduleLeadCall(r.leadId, { reason: `Re-call: "No answer" in sheet tab ${p.tab.title}` });
    recalled++; room--;
  }
  return recalled;
}
