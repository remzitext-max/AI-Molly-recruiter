// The recruiter's status for a driver: the same list as the Status column in the
// lead sheet. Set on the site by a recruiter or copied from the sheet; the statuses
// that mean a recruiter has the driver also set the hiring stage (which stops Crystal).
import type { HireStage } from "@prisma/client";
import { db } from "./db";
import { recordEvent } from "./activity";
import { setHireStage } from "./hiring";

export const RECRUITER_STATUSES = [
  "New", "Need to bring", "Need approval", "Application", "Call back", "Need to talk", "Need teammate", "Paired",
  "No answer", "Not in service", "Not interested", "Changed his mind", "Not qualified", "Declined", "SAP", "Hired", "Our driver – working",
] as const;
export type RecruiterStatus = (typeof RECRUITER_STATUSES)[number];

const key = (s: string) => s.toLowerCase().replace(/[–—-]/g, "-").replace(/\s+/g, " ").replace(/^callback$/, "call back").replace(/changed her mind/, "changed his mind").trim();
const BY_KEY = new Map(RECRUITER_STATUSES.map((s) => [key(s), s]));

/** The list's spelling of a status typed in the sheet ("callback", "our driver - working"), or null. */
export function canonicalStatus(s: string | null | undefined): RecruiterStatus | null {
  return s ? BY_KEY.get(key(s)) ?? null : null;
}

/** Hiring stage a status means; null for New and No answer (Crystal may keep calling). */
export function stageForStatus(s: RecruiterStatus): HireStage | null {
  switch (s) {
    case "New": case "No answer": return null;
    case "Application": return "APPLICATION";
    case "Hired": case "Our driver – working": return "HIRED";
    case "Declined": return "SAFETY_DECLINED";
    case "Not interested": case "Not qualified": case "SAP": case "Not in service": return "NOT_HIRED";
    default: return "PROCESSING";
  }
}

export function statusTone(s: string | null | undefined) {
  const c = canonicalStatus(s);
  if (!c) return "";
  if (["Application", "Hired", "Our driver – working"].includes(c)) return "ok";
  if (["Declined", "Not interested", "Not qualified", "SAP", "Not in service"].includes(c)) return "bad";
  if (["New", "No answer"].includes(c)) return "warn";
  return "info";
}

/** A recruiter sets the status on the site. */
export async function setRecruiterStatus(leadId: string, status: string, actor: { id: string; name: string }, now = new Date()) {
  const s = canonicalStatus(status);
  if (!s) throw new Error("Unknown status");
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
  if (lead.recruiterStatus === s) return { changed: false };
  await db.lead.update({ where: { id: leadId }, data: { recruiterStatus: s, recruiterStatusAt: now } });
  await recordEvent({ leadId, actorType: "USER", actorId: actor.id, type: "RECRUITER_STATUS", message: `Status: ${lead.recruiterStatus ?? "not set"} → ${s} (by ${actor.name})` });
  const stage = stageForStatus(s);
  if (stage && stage !== lead.hireStage) await setHireStage(leadId, stage, lead.hireNote, actor, now);
  return { changed: true };
}

/** The lead sheet's status for a phone changed: copy it onto the lead (the sheet is the newer word). */
export async function copySheetStatus(phoneE164: string, status: string, tab: string, now = new Date()) {
  const s = canonicalStatus(status);
  if (!s) return 0;
  const leads = await db.lead.findMany({ where: { phoneE164, isDemo: false, NOT: { recruiterStatus: s } }, select: { id: true, recruiterStatus: true } });
  for (const l of leads) {
    await db.lead.update({ where: { id: l.id }, data: { recruiterStatus: s, recruiterStatusAt: now } });
    await recordEvent({ leadId: l.id, actorType: "SYSTEM", type: "RECRUITER_STATUS", message: `Status: ${l.recruiterStatus ?? "not set"} → ${s} (lead sheet, ${tab} tab)` });
  }
  return leads.length;
}
