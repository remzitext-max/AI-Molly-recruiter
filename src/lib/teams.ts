// Recruiting teams: other organizations on the same site. A team's logins see only the
// team's leads and dashboard; Crystal calls its leads under the company's name and offer,
// transfers its drivers to the team's own number and posts its cards to its own Telegram group.
import type { User } from "@prisma/client";
import { db } from "./db";
import { hashPassword } from "./auth";
import { normalizePhone } from "./phone";
import { recordEvent } from "./activity";
import { parseSheetLink, teamConnId } from "./team-sheets";

export interface TeamInput {
  name: string;
  sheetLink?: string;
  transferPhone?: string;
  telegramChatId?: string;
}

function teamFields(t: TeamInput) {
  const name = t.name.trim().slice(0, 80);
  if (!name) return { error: "Team name is required" };
  const sheet = t.sheetLink?.trim() ? parseSheetLink(t.sheetLink) : null;
  if (t.sheetLink?.trim() && !sheet) return { error: "That is not a Google Sheets link" };
  const phone = t.transferPhone?.trim() ? normalizePhone(t.transferPhone) : null;
  if (t.transferPhone?.trim() && !phone) return { error: "Transfer number is not a valid US phone number" };
  const chat = t.telegramChatId?.trim() || null;
  if (chat && !/^-?\d{5,20}$/.test(chat)) return { error: "Telegram chat id is a number like -1001234567890" };
  return { data: { name, sheetSpreadsheetId: sheet?.spreadsheetId ?? null, sheetPoolTab: sheet?.tab ?? null, transferPhoneE164: phone, telegramChatId: chat } };
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

export async function updateTeam(owner: Pick<User, "id" | "orgId">, orgId: string, t: TeamInput) {
  const team = await db.organization.findFirst({ where: { id: orgId, isMain: false } });
  if (!team) return { error: "Team not found" };
  const f = teamFields(t);
  if ("error" in f) return { error: f.error };
  await db.organization.update({ where: { id: orgId }, data: f.data });
  // Another sheet or Pool tab: its rows already there are remembered again, not called.
  if (team.sheetSpreadsheetId !== f.data.sheetSpreadsheetId || team.sheetPoolTab !== f.data.sheetPoolTab) {
    await db.sourceConnection.deleteMany({ where: { id: teamConnId(orgId) } });
  }
  await recordEvent({ actorType: "USER", actorId: owner.id, orgId: owner.orgId, type: "TEAM_UPDATED", message: `Team ${f.data.name} updated` });
  return { ok: true, transferChanged: team.transferPhoneE164 !== f.data.transferPhoneE164 };
}
