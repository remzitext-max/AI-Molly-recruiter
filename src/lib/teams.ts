// Recruiting teams: other organizations on the same site. A team's logins see only the
// team's leads and dashboard; Crystal calls its leads under the company's name and offer,
// transfers its drivers to the team's own number and posts its cards to its own Telegram group.
import type { User } from "@prisma/client";
import { db } from "./db";
import { hashPassword } from "./auth";
import { normalizePhone } from "./phone";
import { recordEvent } from "./activity";
import { parseSheetLink, teamConnId } from "./team-sheets";
import { normalizeOfficeHours } from "./office-hours";

const DEFAULT_TEAM_HOURS = "17:00-05:00";

export interface TeamInput {
  name: string;
  sheetLink?: string;
  transferPhone?: string;
  telegramChatId?: string;
  /** Recruiters' hours in Tashkent time, "17:00-05:00"; empty = always at work. */
  officeHours?: string;
  /** Re-call "No answer" drivers from the team's sheet tabs who applied minDays-maxDays ago; minDays 0 = off. */
  recall?: { minDays: number; maxDays: number; perDay: number };
}

function recallFields(r: NonNullable<TeamInput["recall"]>) {
  const n = (v: number, lo: number, hi: number, d: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  const recallMinDays = n(r.minDays, 0, 365, 0), recallMaxDays = n(r.maxDays, 1, 365, 60);
  if (recallMinDays > 0 && recallMaxDays <= recallMinDays) return { error: "Re-call days: the second number must be bigger than the first" };
  return { data: { recallMinDays, recallMaxDays, recallPerDay: n(r.perDay, 1, 200, 25) } };
}

function teamFields(t: TeamInput) {
  const name = t.name.trim().slice(0, 80);
  if (!name) return { error: "Team name is required" };
  const sheet = t.sheetLink?.trim() ? parseSheetLink(t.sheetLink) : null;
  if (t.sheetLink?.trim() && !sheet) return { error: "That is not a Google Sheets link" };
  const phone = t.transferPhone?.trim() ? normalizePhone(t.transferPhone) : null;
  if (t.transferPhone?.trim() && !phone) return { error: "Transfer number is not a valid US phone number" };
  // Group ids are negative; a supergroup id pasted without its minus ("100…") still works.
  const raw = t.telegramChatId?.trim().replace(/\s+/g, "") || null;
  const chat = raw && /^100\d{8,}$/.test(raw) ? `-${raw}` : raw;
  if (chat && !/^-?\d{5,20}$/.test(chat)) return { error: "Telegram chat id is a number like -1001234567890" };
  const officeHours = t.officeHours === undefined ? DEFAULT_TEAM_HOURS : normalizeOfficeHours(t.officeHours);
  if (officeHours === undefined) return { error: "Office hours look like 17:00-05:00 (Tashkent time)" };
  return { data: { name, sheetSpreadsheetId: sheet?.spreadsheetId ?? null, sheetPoolTab: sheet?.tab ?? null, transferPhoneE164: phone, telegramChatId: chat, officeHours } };
}

/** Creates the team, its campaign (a copy of the main one, same offer) and its manager's login. */
export async function createTeam(owner: Pick<User, "id" | "orgId">, t: TeamInput & { managerName: string; managerEmail: string; password: string }) {
  const f = teamFields(t);
  if ("error" in f) return { error: f.error };
  const email = t.managerEmail.toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "Manager's login email is required" };
  if (t.password.length < 12) return { error: "Temporary password needs at least 12 characters" };
  if (await db.user.findUnique({ where: { email } })) return { error: "That login email already exists" };
  const main = await db.campaign.findFirst({ where: { orgId: owner.orgId, offerId: { not: null } }, orderBy: [{ isDemo: "asc" }, { createdAt: "asc" }] });
  if (!main) return { error: "Publish the offer on the main campaign first" };
  const passwordHash = await hashPassword(t.password);
  const org = await db.$transaction(async (tx) => {
    const org = await tx.organization.create({ data: { ...f.data, isMain: false } });
    await tx.campaign.create({
      data: {
        orgId: org.id, name: `${f.data.name} drivers`, isDemo: main.isDemo, offerId: main.offerId, assignmentMode: main.assignmentMode,
        maxAttempts: main.maxAttempts, retryDelayMinutes: main.retryDelayMinutes, contactWindowStart: main.contactWindowStart,
        contactWindowEnd: main.contactWindowEnd, contactDays: main.contactDays, hotCallMinutes: main.hotCallMinutes, reengageAfterDays: main.reengageAfterDays,
      },
    });
    await tx.user.create({ data: { orgId: org.id, email, name: t.managerName.trim().slice(0, 80) || email, role: "ADMIN", passwordHash, inRoundRobin: true } });
    return org;
  });
  await recordEvent({ actorType: "USER", actorId: owner.id, orgId: owner.orgId, type: "TEAM_CREATED", message: `Team ${org.name} created with manager login ${email}` });
  return { orgId: org.id };
}

/** The company's own recruiters' hours (Tashkent time). */
export async function updateMainOfficeHours(owner: Pick<User, "id" | "orgId">, text: string) {
  const officeHours = normalizeOfficeHours(text);
  if (officeHours === undefined) return { error: "Office hours look like 17:00-03:00 (Tashkent time)" };
  await db.organization.update({ where: { id: owner.orgId }, data: { officeHours } });
  await recordEvent({ actorType: "USER", actorId: owner.id, orgId: owner.orgId, type: "OFFICE_HOURS", message: `Office hours set to ${officeHours ?? "always"} (Tashkent)` });
  return { ok: true };
}

export async function updateTeam(owner: Pick<User, "id" | "orgId">, orgId: string, t: TeamInput) {
  const team = await db.organization.findFirst({ where: { id: orgId, isMain: false } });
  if (!team) return { error: "Team not found" };
  const f = teamFields(t);
  if ("error" in f) return { error: f.error };
  const recall = t.recall ? recallFields(t.recall) : null;
  if (recall && "error" in recall) return { error: recall.error };
  await db.organization.update({ where: { id: orgId }, data: f.data });
  if (recall) await db.campaign.updateMany({ where: { orgId }, data: recall.data });
  // Another sheet or Pool tab: its rows already there are remembered again, not called.
  if (team.sheetSpreadsheetId !== f.data.sheetSpreadsheetId || team.sheetPoolTab !== f.data.sheetPoolTab) {
    await db.sourceConnection.deleteMany({ where: { id: teamConnId(orgId) } });
  }
  await recordEvent({ actorType: "USER", actorId: owner.id, orgId: owner.orgId, type: "TEAM_UPDATED", message: `Team ${f.data.name} updated` });
  return { ok: true, transferChanged: team.transferPhoneE164 !== f.data.transferPhoneE164 };
}
