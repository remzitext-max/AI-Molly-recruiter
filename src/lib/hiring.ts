// Hiring result for a lead, set by a recruiter after the hand-off. Crystal never
// sets it. It is what turns "interested drivers" into lead-to-hire and cost per hire.
import type { HireStage } from "@prisma/client";
import { db } from "./db";
import { recordEvent } from "./activity";
import { cancelPendingOutreach } from "./leads";
import { enqueue } from "./jobs/queue";
import { telegramConfigured } from "./telegram";
import { metaEventsConfigured, queueMetaStageEvent } from "./meta";
import { sendLeadEvent } from "../adapters/live/meta";
import { getAdapters } from "../adapters/registry";
import { normalizePhone } from "./phone";
import { config } from "./config";
import { log } from "./redact";
import { recallNoAnswerLeads, teamTarget, type SheetTab } from "./sheet-recall";
import { teamSource } from "./team-sheets";
import { getSheetConnection } from "./sheets-sync";
import type { Mapping } from "./import";
import { copySheetStatus } from "./recruiter-status";
import { assignFromSheetTabs } from "./assignment";
import { processRowsOf, saveProcessRows } from "./on-process";
import type { SheetSnapshot } from "../adapters/types";

export const HIRE_STAGES: HireStage[] = ["NONE", "PROCESSING", "APPLICATION", "ORIENTATION", "HIRED", "SAFETY_DECLINED", "NOT_HIRED"];
export const HIRE_LABEL: Record<HireStage, string> = {
  NONE: "Not set",
  PROCESSING: "Processing by recruiter",
  APPLICATION: "Application in",
  ORIENTATION: "Orientation booked",
  HIRED: "Hired",
  SAFETY_DECLINED: "Declined by safety",
  NOT_HIRED: "Not hired",
};

/** actor.id null = the lead sheet (a recruiter changed the Status column there). */
export async function setHireStage(leadId: string, stage: HireStage, note: string | null, actor: { id: string | null; name: string }, now = new Date()) {
  if (!HIRE_STAGES.includes(stage)) throw new Error("Unknown hiring stage");
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
  const cleanNote = note?.trim().slice(0, 500) || null;
  if (lead.hireStage === stage && (lead.hireNote ?? null) === cleanNote) return { changed: false };
  await db.$transaction(async (tx) => {
    await tx.lead.update({
      where: { id: leadId },
      data: {
        hireStage: stage,
        hireStageAt: stage === lead.hireStage ? lead.hireStageAt : now,
        hiredAt: stage === "HIRED" ? lead.hiredAt ?? now : null,
        hireNote: cleanNote,
      },
    });
    // Any status means a recruiter has the driver: Crystal stops calling and texting them.
    if (stage !== "NONE") {
      await cancelPendingOutreach(leadId, tx);
      await tx.lead.update({ where: { id: leadId }, data: { nextContactAt: null, queueReason: `Recruiter is working with the driver (status: ${HIRE_LABEL[stage]})` } });
    }
    await recordEvent({ leadId, actorType: actor.id ? "USER" : "SYSTEM", actorId: actor.id, type: "HIRE_STAGE", message: `Hiring: ${HIRE_LABEL[lead.hireStage]} → ${HIRE_LABEL[stage]} (by ${actor.name})${cleanNote ? `: ${cleanNote}` : ""}` }, tx);
    if (stage === "HIRED" && lead.hireStage !== "HIRED") {
      await queueMetaStageEvent(leadId, "HIRED", tx);
      if (telegramConfigured() && !lead.isDemo) await enqueue("notify.telegram-hired", { leadId, by: actor.name }, { idempotencyKey: `telegram-hired:${leadId}`, maxAttempts: 3 }, tx);
    }
  });
  return { changed: true };
}

// Recruiters work in the lead sheet, not on this site. Every 15 minutes the recruiter tabs
// are read: Status "Application" / "Hired" is copied onto the matching lead (by phone), and
// good outcomes are reported to Facebook so it finds more drivers like them.
const SHEET_STATUS: { re: RegExp; stage?: HireStage; event: string }[] = [
  { re: /^(interested|need to talk|call ?back|need (a )?teammate|changed (his |her )?mind)$/i, event: "Interested" },
  { re: /^(need to bring|need approval|paired)$/i, event: "Qualified" },
  { re: /^application$/i, stage: "APPLICATION", event: "Application" },
  { re: /^hired$/i, stage: "HIRED", event: "Hired" },
];
const RANK: Record<HireStage, number> = { NONE: 0, NOT_HIRED: 0, SAFETY_DECLINED: 0, PROCESSING: 1, APPLICATION: 2, ORIENTATION: 3, HIRED: 4 };

export async function syncHiringFromSheet(now = new Date()) {
  const src = getAdapters().sheets;
  if (!src.listTabs || !config.googleSheets.spreadsheetId) return { tabs: 0, updated: 0, sent: 0, recalled: 0, assigned: 0 };
  const meta = metaEventsConfigured() && config.mode === "live";
  let tabs = 0, updated = 0, sent = 0;
  const latest = new Map<string, { tab: string; status: string }>();
  const read: SheetTab[] = [];
  for (const { title, gid, snap } of await readAllTabs()) {
    if (!snap) continue;
    const phoneI = snap.headers.findIndex((h) => /^phone$/i.test(h));
    const statusI = snap.headers.findIndex((h) => /^status$/i.test(h));
    if (phoneI < 0 || statusI < 0) continue;
    tabs++;
    read.push({ title, gid, snap });
    for (const row of snap.rows) {
      const status = (row[statusI] ?? "").trim();
      const rowPhone = normalizePhone(row[phoneI] ?? "");
      // A phone in two tabs: the one a recruiter has worked wins over "No answer".
      if (rowPhone && (!latest.has(rowPhone) || !OPEN_STATUS.test(status))) latest.set(rowPhone, { tab: title.slice(0, 100), status: status.slice(0, 100) });
      const hit = SHEET_STATUS.find((s) => s.re.test(status));
      const phone = hit && rowPhone;
      if (!hit || !phone) continue;
      const lead = await db.lead.findFirst({ where: { phoneE164: phone, isDemo: false }, orderBy: { createdAt: "desc" } });
      // Only moves forward: a recruiter's choice on the site, or a later stage, is never undone.
      // "Hired" on a lead of ours goes to Facebook from setHireStage (with the lead's FB id).
      if (lead && hit.stage && RANK[lead.hireStage] < RANK[hit.stage]) {
        await setHireStage(lead.id, hit.stage, lead.hireNote, { id: null, name: `lead sheet (${title} tab)` });
        updated++;
      }
      if (!meta || (lead && hit.event === "Hired")) continue;
      if (await reportSheetStatus(phone, hit.event, status, title, lead, now)) sent++;
    }
  }
  if (meta) sent += await reportOtherTeamSheets(now);
  // The "On process" page: every recruiter tab's drivers on their way in, called by Crystal or not.
  const main = await db.organization.findFirst({ where: { isMain: true }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (main && read.length) await saveProcessRows(main.id, read.flatMap(({ title, snap }) => processRowsOf(title, snap!.headers, snap!.rows, normalizePhone)), now);
  const t = await readTeamSheets(latest, now);
  tabs += t.tabs; updated += t.updated;
  const known = new Map((await db.sheetLeadStatus.findMany()).map((r) => [r.phoneE164, r]));
  const movedTab: { phoneE164: string; tab: string }[] = [];
  for (const [phoneE164, v] of latest) {
    const k = known.get(phoneE164);
    if (k?.tab !== v.tab) movedTab.push({ phoneE164, tab: v.tab });
    if (k && k.tab === v.tab && k.status === v.status) continue;
    await db.sheetLeadStatus.upsert({ where: { phoneE164 }, create: { phoneE164, ...v }, update: { ...v, seenAt: new Date() } });
    await copySheetStatus(phoneE164, v.status, v.tab, now);
  }
  // Only a move between tabs reassigns, so a transfer made on the site is not undone every 15 minutes.
  const assigned = await assignFromSheetTabs(movedTab);
  const recalled = (await recallNoAnswerLeads(read, now)) + t.recalled;
  return { tabs, updated, sent, recalled, assigned };
}

/**
 * Recruiting teams' own sheets (Teams page): every tab is read for their leads only, so a
 * team recruiter's status stops Crystal and a move to their tab assigns the lead to them.
 * A phone in the main sheet keeps the main sheet's status. Facebook events for these
 * sheets come from reportOtherTeamSheets, like the other teams'. Their "No answer" drivers
 * are re-called with the team's campaign settings, like the main sheet's.
 */
async function readTeamSheets(latest: Map<string, { tab: string; status: string }>, now: Date) {
  const mainPhones = new Set(latest.keys());
  let tabs = 0, updated = 0, recalled = 0;
  const mainMapping = ((await getSheetConnection())?.mapping as Mapping | null) ?? null;
  const teams = await db.organization.findMany({ where: { isMain: false, sheetSpreadsheetId: { not: null } } });
  for (const org of teams) {
    const id = org.sheetSpreadsheetId!;
    const list = await readAllTabs(id).catch((e) => { log.warn("team sheet not readable (share it with the service account)", { team: org.name, error: String(e) }); return []; });
    const theirs = new Set((await db.lead.findMany({ where: { orgId: org.id, isDemo: false }, select: { phoneE164: true } })).map((l) => l.phoneE164));
    if (list.length) await saveProcessRows(org.id, list.flatMap(({ title, snap }) => (snap ? processRowsOf(title, snap.headers, snap.rows, normalizePhone) : [])));
    for (const { title, snap } of list) {
      const phoneI = snap?.headers.findIndex((h) => /^phone$/i.test(h)) ?? -1;
      const statusI = snap?.headers.findIndex((h) => /^status$/i.test(h)) ?? -1;
      if (!snap || phoneI < 0 || statusI < 0) continue;
      tabs++;
      for (const row of snap.rows) {
        const status = (row[statusI] ?? "").trim();
        const phone = normalizePhone(row[phoneI] ?? "");
        if (!phone || !theirs.has(phone) || mainPhones.has(phone)) continue;
        if (!latest.has(phone) || !OPEN_STATUS.test(status)) latest.set(phone, { tab: title.slice(0, 100), status: status.slice(0, 100) });
        const stage = SHEET_STATUS.find((s) => s.re.test(status))?.stage;
        if (!stage) continue;
        const lead = await db.lead.findUnique({ where: { orgId_phoneE164: { orgId: org.id, phoneE164: phone } } });
        if (lead && RANK[lead.hireStage] < RANK[stage]) {
          await setHireStage(lead.id, stage, lead.hireNote, { id: null, name: `${org.name} sheet (${title} tab)` });
          updated++;
        }
      }
    }
    const campaign = await db.campaign.findFirst({ where: { orgId: org.id }, orderBy: [{ isDemo: "asc" }, { createdAt: "asc" }], select: { id: true } });
    const read: SheetTab[] = list.flatMap(({ title, gid, snap }) => (snap ? [{ title, gid, snap }] : []));
    if (campaign && read.length) recalled += await recallNoAnswerLeads(read, now, teamTarget(org.id, campaign.id, (gid) => `${teamSource(org.id)}:${gid}`, mainMapping));
  }
  return { tabs, updated, recalled };
}

/**
 * One good sheet status to Facebook, once per driver and event across every team's sheet.
 * Returns false when it was already sent (from a sheet, or by Crystal / the site).
 */
async function reportSheetStatus(phone: string, event: string, status: string, tab: string, lead: { id: string; fbLeadId: string | null } | null, now: Date) {
  const key = { phoneE164: phone, eventName: event };
  if (await db.metaSheetEvent.findUnique({ where: { phoneE164_eventName: key } })) return false;
  const row = { ...key, tab: tab.slice(0, 100), status: status.slice(0, 100) };
  // Crystal's own "Interested" (or a stage set on the site) already went to Facebook.
  const already = lead && (await db.activityEvent.count({ where: { leadId: lead.id, type: "META_EVENT", message: { startsWith: `Sent "${event}"` } } }));
  if (already) { await db.metaSheetEvent.create({ data: row }); return false; }
  const r = await sendLeadEvent({ eventName: event, time: now, fbLeadId: lead?.fbLeadId, phoneE164: phone, eventId: `sheet:${phone}:${event}` });
  await db.metaSheetEvent.create({ data: row });
  if (lead) await recordEvent({ leadId: lead.id, actorType: "SYSTEM", type: "META_EVENT", message: `Sent "${event}" to Facebook (sheet ${tab} tab: ${status})${r.events_received ? "" : ": not confirmed"}` });
  return true;
}

// Events sent per run from the other teams' sheets: their whole history goes out over the
// first few runs (every 15 minutes) instead of one run outliving the job lock.
const OTHER_TEAMS_PER_RUN = 150;

/** The other teams' lead sheets: good statuses go to Facebook too, nothing else is read from them. */
async function reportOtherTeamSheets(now: Date) {
  const src = getAdapters().sheets;
  let sent = 0;
  const teamSheets = (await db.organization.findMany({ where: { isMain: false, sheetSpreadsheetId: { not: null } }, select: { sheetSpreadsheetId: true } })).map((o) => o.sheetSpreadsheetId!);
  for (const id of new Set([...config.googleSheets.metaSpreadsheets, ...teamSheets])) {
    if (id === config.googleSheets.spreadsheetId) continue;
    const tabs = await readAllTabs(id).catch((e) => { log.warn("other team sheet not readable (share it with the service account)", { id, error: String(e) }); return []; });
    for (const { title, snap } of tabs) {
      const phoneI = snap?.headers.findIndex((h) => /^phone$/i.test(h)) ?? -1;
      const statusI = snap?.headers.findIndex((h) => /^status$/i.test(h)) ?? -1;
      if (!snap || phoneI < 0 || statusI < 0) continue;
      for (const row of snap.rows) {
        const status = (row[statusI] ?? "").trim();
        const hit = SHEET_STATUS.find((s) => s.re.test(status));
        const phone = hit && normalizePhone(row[phoneI] ?? "");
        if (!hit || !phone) continue;
        if (sent >= OTHER_TEAMS_PER_RUN) return sent;
        const lead = await db.lead.findFirst({ where: { phoneE164: phone, isDemo: false }, orderBy: { createdAt: "desc" }, select: { id: true, fbLeadId: true } });
        if (await reportSheetStatus(phone, hit.event, status, title, lead, now)) sent++;
      }
    }
  }
  return sent;
}

/**
 * Every tab of a spreadsheet (default: the lead sheet), read in one request where the source
 * can: Google allows 60 reads a minute, and the Pool is read every few seconds too.
 */
async function readAllTabs(spreadsheetId?: string): Promise<{ title: string; gid: string; snap: SheetSnapshot | null }[]> {
  const src = getAdapters().sheets;
  const tabs = await src.listTabs!(spreadsheetId);
  const snaps = src.readTabs
    ? await src.readTabs(tabs.map((t) => t.title), spreadsheetId)
    : await Promise.all(tabs.map((t) => src.readSheet(t.title, spreadsheetId).catch(() => null)));
  return tabs.map((t, i) => ({ ...t, snap: snaps[i] }));
}

// Statuses that still mean "nobody has talked to this driver".
const OPEN_STATUS = /^(|no answer|no response|new)$/i;

/** The sheet row that says a recruiter has already talked to this driver, if any. */
export async function recruiterWorkedStatus(phoneE164: string) {
  const r = await db.sheetLeadStatus.findUnique({ where: { phoneE164 } });
  return r && !OPEN_STATUS.test(r.status) ? r : null;
}

/** Called by the worker every minute; reads the sheet's recruiter tabs every 15 minutes. */
export async function scheduleHiringSync(now = Date.now()) {
  if (config.mode !== "live" || !config.googleSheets.spreadsheetId) return;
  await enqueue("source.google-sheets.hiring", {}, { idempotencyKey: `gsheets-hiring:${Math.floor(now / 900_000)}`, maxAttempts: 1 });
}
