// Which recruiter's tab of the lead sheet a driver belongs to, and that recruiter's
// phone for Crystal's live transfer ("let me connect you with my manager").
import { config } from "./config";
import { db } from "./db";
import { getAdapters } from "../adapters/registry";
import { normalizePhone } from "./phone";
import { getSettings } from "./settings";

let tabTitles: { at: number; byGid: Map<string, string> } | null = null;

/** Sheet tab titles by gid, read at most every 10 minutes. */
async function tabTitle(gid: string): Promise<string | undefined> {
  if (!tabTitles || Date.now() - tabTitles.at > 600_000) {
    const tabs = (await getAdapters().sheets.listTabs?.().catch(() => null)) ?? null;
    if (tabs) tabTitles = { at: Date.now(), byGid: new Map(tabs.map((t) => [t.gid, t.title])) };
  }
  return tabTitles?.byGid.get(gid);
}

/**
 * The tab the lead came from (an extra recruiter tab, a re-called "No answer" row) or the
 * tab a recruiter moved it to from the Pool. Null for Pool leads and leads not in the sheet.
 */
export async function leadSheetTab(leadId: string): Promise<string | null> {
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { phoneE164: true, sourceRecords: { select: { sourceSystem: true, raw: true } } } });
  if (!lead) return null;
  const gid = config.googleSheets.extraTabs.map((t) => t.gid).find((g) => lead.sourceRecords.some((r) => r.sourceSystem === `GOOGLE_SHEETS:${g}`));
  const tab = (gid && (await tabTitle(gid)))
    ?? lead.sourceRecords.map((r) => (r.raw as { tab?: string } | null)?.tab).find(Boolean)
    ?? (await db.sheetLeadStatus.findUnique({ where: { phoneE164: lead.phoneE164 } }))?.tab;
  return tab && !/pool/i.test(tab) ? tab : null;
}

/** "Dennis = +18158461661" lines from Settings, by tab name in lower case. */
export function parseRecruiterPhones(text: string): Map<string, { tab: string; phone: string }> {
  const m = new Map<string, { tab: string; phone: string }>();
  for (const line of text.split("\n")) {
    const [tab, raw] = line.split("=").map((x) => x?.trim() ?? "");
    const phone = normalizePhone(raw);
    if (tab && phone) m.set(tab.toLowerCase(), { tab, phone });
  }
  return m;
}

/**
 * Transfer target for drivers whose tab has no phone in Settings. Not "manager": Crystal calls the
 * recruiter "my manager", and with a target of that name the model picked it for Dennis's drivers too.
 */
export const DEFAULT_TRANSFER_TARGET = "office";

/** Transfer target names for the Telnyx assistant: one per recruiter tab with a phone. */
export function transferTargetName(tab: string) {
  return tab.replace(/[^A-Za-z0-9]+/g, "_");
}

/** The recruiter this driver's call should be transferred to, when their tab has a phone in Settings. */
export async function tabRecruiterPhone(leadId: string): Promise<{ tab: string; phone: string } | null> {
  const phones = parseRecruiterPhones((await getSettings()).recruiterTransfer);
  if (!phones.size) return null;
  const tab = await leadSheetTab(leadId);
  return (tab && phones.get(tab.toLowerCase())) || null;
}

/** Transfer target of a recruiting team (its own number, set on Teams). */
export const teamTransferTarget = (org: { name: string }) => transferTargetName(`team ${org.name}`);

/** A team's transfer number for this lead, or null for the company's own leads. */
export async function teamTransfer(leadId: string): Promise<{ target: string; phone: string | null } | null> {
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { org: { select: { isMain: true, name: true, transferPhoneE164: true } } } });
  if (!lead || lead.org.isMain) return null;
  return { target: teamTransferTarget(lead.org), phone: lead.org.transferPhoneE164 };
}
