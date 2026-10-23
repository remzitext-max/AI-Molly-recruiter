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
import { recallNoAnswerLeads, type SheetTab } from "./sheet-recall";

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
  { re: /^(interested|need to talk|call ?back|need (a )?teammate|changed his mind)$/i, event: "Interested" },
  { re: /^(need to bring|need approval|paired)$/i, event: "Qualified" },
  { re: /^application$/i, stage: "APPLICATION", event: "Application" },
  { re: /^hired$/i, stage: "HIRED", event: "Hired" },
];
const RANK: Record<HireStage, number> = { NONE: 0, NOT_HIRED: 0, SAFETY_DECLINED: 0, PROCESSING: 1, APPLICATION: 2, ORIENTATION: 3, HIRED: 4 };

export async function syncHiringFromSheet(now = new Date()) {
  const src = getAdapters().sheets;
  if (!src.listTabs || !config.googleSheets.spreadsheetId) return { tabs: 0, updated: 0, sent: 0, recalled: 0 };
  const meta = metaEventsConfigured() && config.mode === "live";
  let tabs = 0, updated = 0, sent = 0;
  const latest = new Map<string, { tab: string; status: string }>();
  const read: SheetTab[] = [];
  for (const { title, gid } of await src.listTabs()) {
    const snap = await src.readSheet(title).catch(() => null);
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
      const key = { phoneE164: phone, eventName: hit.event };
      if (await db.metaSheetEvent.findUnique({ where: { phoneE164_eventName: key } })) continue;
      // Crystal's own "Interested" (or a stage set on the site) already went to Facebook.
      const already = lead && (await db.activityEvent.count({ where: { leadId: lead.id, type: "META_EVENT", message: { startsWith: `Sent "${hit.event}"` } } }));
      if (already) { await db.metaSheetEvent.create({ data: { ...key, tab: title.slice(0, 100), status: status.slice(0, 100) } }); continue; }
      const r = await sendLeadEvent({ eventName: hit.event, time: now, fbLeadId: lead?.fbLeadId, phoneE164: phone, eventId: `sheet:${phone}:${hit.event}` });
      await db.metaSheetEvent.create({ data: { ...key, tab: title.slice(0, 100), status: status.slice(0, 100) } });
      if (lead) await recordEvent({ leadId: lead.id, actorType: "SYSTEM", type: "META_EVENT", message: `Sent "${hit.event}" to Facebook (sheet ${title} tab: ${status})${r.events_received ? "" : ": not confirmed"}` });
      sent++;
    }
  }
  const known = new Map((await db.sheetLeadStatus.findMany()).map((r) => [r.phoneE164, r]));
  for (const [phoneE164, v] of latest) {
    const k = known.get(phoneE164);
    if (k && k.tab === v.tab && k.status === v.status) continue;
    await db.sheetLeadStatus.upsert({ where: { phoneE164 }, create: { phoneE164, ...v }, update: { ...v, seenAt: new Date() } });
  }
  const recalled = await recallNoAnswerLeads(read, now);
  return { tabs, updated, sent, recalled };
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
