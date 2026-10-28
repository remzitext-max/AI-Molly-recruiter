// Recruiting teams on the site (Organization.isMain false) bring their own lead sheet.
// New rows in its Pool tab become the team's leads, and Crystal calls them the same
// way (company name and offer of the main campaign). Rows already in the Pool when
// the team was set up are remembered on the first read and never called.
import type { Organization, Prisma } from "@prisma/client";
import { db } from "./db";
import { config } from "./config";
import { sha256 } from "./crypto";
import { redactText } from "./redact";
import { buildPreview, commitBatch, guessMapping, SHEETS_SOURCE, type Mapping, type ParsedSheet } from "./import";
import { getSheetConnection, phonesOfOtherOrgs, sheetMapping } from "./sheets-sync";
import { getAdapters } from "../adapters/registry";

export const teamConnId = (orgId: string) => `google-sheets@${orgId}`;
export const teamSource = (orgId: string) => `${SHEETS_SOURCE}@${orgId}`;

/** Spreadsheet id and "gid:<tab>" from a pasted Google Sheets link (or a bare id). */
export function parseSheetLink(link: string): { spreadsheetId: string; tab: string | null } | null {
  const s = link.trim();
  const id = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(s)?.[1] ?? (/^[A-Za-z0-9_-]{20,}$/.test(s) ? s : null);
  if (!id) return null;
  const gid = /[#?&]gid=(\d+)/.exec(s)?.[1];
  return { spreadsheetId: id, tab: gid ? `gid:${gid}` : null };
}

export async function pollTeamSheets() {
  const teams = await db.organization.findMany({ where: { isMain: false, sheetSpreadsheetId: { not: null } } });
  for (const t of teams) await pollTeamSheet(t);
}

export async function pollTeamSheet(org: Organization) {
  const id = teamConnId(org.id);
  try {
    const campaign = await db.campaign.findFirst({ where: { orgId: org.id }, orderBy: [{ isDemo: "asc" }, { createdAt: "asc" }] });
    if (!campaign) throw new Error("The team has no campaign");
    const snap = await getAdapters().sheets.readSheet(org.sheetPoolTab || "A:Z", org.sheetSpreadsheetId!);
    // The main sheet's reviewed mapping where the headers are the same, a guess for the rest.
    const main = (await getSheetConnection())?.mapping as Mapping | null;
    const mapping = sheetMapping(snap.headers, { ...guessMapping(snap.headers), ...(main ?? {}) });
    if (mapping.sourceRecordId && !snap.headers.includes(mapping.sourceRecordId)) delete mapping.sourceRecordId;
    if (!mapping.phone) throw new Error(`The team's Pool tab has no phone column. Found: ${snap.headers.filter(Boolean).join(", ") || "(empty)"}`);
    const sheet: ParsedSheet = { headers: snap.headers, rows: snap.rows, warnings: snap.warnings };
    const preview = await buildPreview(sheet, mapping, teamSource(org.id), org.id);
    const existing = await db.sourceConnection.findUnique({ where: { id } });
    const saved = (existing?.mapping as { baseline?: string[] } | null)?.baseline;
    if (!saved) {
      // First successful look: remember what is already in the Pool and import nothing.
      const ids = preview.map((r) => r.sourceRecordId).filter(Boolean);
      const data = { orgId: org.id, campaignId: campaign.id, mapping: { baseline: ids }, lastSyncAt: new Date(), lastSummary: { baselineRows: ids.length }, lastError: null };
      await db.sourceConnection.upsert({ where: { id }, create: { id, ...data }, update: data });
      return { baseline: ids.length };
    }
    const baseline = new Set(saved);
    let fresh = preview.filter((r) => !baseline.has(r.sourceRecordId) && (r.disposition === "new" || r.disposition === "merge_existing_phone" || r.disposition === "suppressed"));
    const elsewhere = await phonesOfOtherOrgs(org.id, fresh.map((r) => r.phoneE164!).filter(Boolean));
    fresh = fresh.filter((r) => !elsewhere.has(r.phoneE164!));
    let imported: Record<string, number> | null = null;
    if (fresh.length) {
      const rows = fresh.map((r) => snap.rows[r.rowNumber - 2]);
      const batch = await db.importBatch.create({
        data: {
          fileName: `${org.name} sheet: ${snap.title}`.slice(0, 200), fileSha256: sha256(JSON.stringify([snap.headers, rows])), sourceSystem: teamSource(org.id),
          mapping: mapping as Prisma.InputJsonValue, rows: { headers: snap.headers, rows, warnings: snap.warnings } as Prisma.InputJsonValue,
          campaignId: campaign.id, isDemo: config.mode === "demo" || campaign.isDemo, createdById: "system",
        },
      });
      imported = await commitBatch(batch.id, { id: null, orgId: org.id });
    }
    const summary = { checkedRows: snap.rows.length, imported, skippedOtherTeam: elsewhere.size };
    await db.sourceConnection.update({ where: { id }, data: { lastSyncAt: new Date(), lastSummary: summary as Prisma.InputJsonValue, lastError: null } });
    return summary;
  } catch (e) {
    const msg = redactText((e as Error).message).slice(0, 500);
    // Saved without a baseline, so the first read that works still only remembers the rows.
    await db.sourceConnection.upsert({ where: { id }, create: { id, orgId: org.id, lastSyncAt: new Date(), lastError: msg }, update: { lastSyncAt: new Date(), lastError: msg } });
    return { error: msg };
  }
}
