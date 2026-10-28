// Google Sheets lead sync. The first import is always reviewed by an admin
// (mapping preview); that commit saves the mapping and campaign. After that,
// automatic syncs import only rows not seen before. Rows are identified by the
// sheet's ID column, or by phone number when the ID is empty, never by row number, so sorting,
// inserting or deleting rows in the sheet never creates duplicate outreach.
import type { PipelineStatus, Prisma } from "@prisma/client";
import { db } from "./db";
import { config } from "./config";
import { sha256 } from "./crypto";
import { redactText } from "./redact";
import { buildPreview, commitBatch, guessMapping, SHEETS_SOURCE, type Mapping, type ParsedSheet } from "./import";
import { enqueue } from "./jobs/queue";
import { getAdapters } from "../adapters/registry";
import type { SheetSnapshot } from "../adapters/types";

export const SHEETS_CONN_ID = "google-sheets";

export const getSheetConnection = () => db.sourceConnection.findUnique({ where: { id: SHEETS_CONN_ID } });

/** Text written to the sheet's status column. Deliberately never says "hired". */
export const SHEET_STATUS_LABEL: Record<PipelineStatus, string> = {
  NEW: "New", NEEDS_PERMISSION: "Waiting for contact permission", NEEDS_TIMEZONE: "Needs state/ZIP for timezone",
  QUEUED: "Queued for AI call", CONTACTING: "AI calling", CALLBACK_SCHEDULED: "Callback scheduled",
  INTERESTED: "Interested", NOT_INTERESTED: "Not interested", DOCS_REQUESTED: "CDL requested", DOCS_RECEIVED: "CDL received",
  HANDOFF_READY: "Ready for recruiter", HANDED_OFF: "With recruiter (not hired)", OPTED_OUT: "Opted out - do not contact", CLOSED: "Closed",
};

/** Mapping with the ID column forced to the configured one, dropping headers that no longer exist. */
export function sheetMapping(headers: string[], saved?: Mapping | null): Mapping {
  const base: Mapping = { ...(saved ?? guessMapping(headers)) };
  for (const [k, h] of Object.entries(base)) if (!headers.includes(h!)) delete base[k as keyof Mapping];
  const id = getAdapters().sheets.idColumn;
  if (id) base.sourceRecordId = id;
  return base;
}

async function readChecked(range?: string): Promise<SheetSnapshot> {
  const src = getAdapters().sheets;
  const snap = await src.readSheet(range);
  if (!src.idColumn) throw new Error("No ID column configured (GOOGLE_SHEETS_ID_COLUMN)");
  if (!snap.headers.includes(src.idColumn)) throw new Error(`The sheet has no "${src.idColumn}" column in its first row. Found: ${snap.headers.filter(Boolean).join(", ") || "(empty)"}`);
  if (snap.rows.length > 5000) throw new Error(`The sheet has ${snap.rows.length} rows; the limit per sync is 5000`);
  return snap;
}

/** Admin action: read the sheet and open the normal import preview for review. */
export async function createSheetPreview(user: { id: string; orgId: string }, campaignId: string) {
  const campaign = await db.campaign.findFirstOrThrow({ where: { id: campaignId, orgId: user.orgId } });
  const snap = await readChecked();
  const conn = await getSheetConnection();
  const mapping = sheetMapping(snap.headers, conn?.mapping as Mapping | null);
  return db.importBatch.create({
    data: {
      fileName: `Google Sheet: ${snap.title}`.slice(0, 200), fileSha256: sha256(JSON.stringify([snap.headers, snap.rows])), sourceSystem: SHEETS_SOURCE,
      mapping: mapping as Prisma.InputJsonValue, rows: { headers: snap.headers, rows: snap.rows, warnings: snap.warnings } as Prisma.InputJsonValue,
      campaignId: campaign.id, isDemo: config.mode === "demo" || campaign.isDemo, createdById: user.id,
    },
  });
}

/**
 * Phones that are already a lead of another team (or of the main company). A driver who
 * applied to two teams' ads stays with the first one, so Crystal never calls them twice.
 */
export async function phonesOfOtherOrgs(orgId: string, phones: string[]) {
  if (!phones.length) return new Set<string>();
  const rows = await db.lead.findMany({ where: { phoneE164: { in: phones }, orgId: { not: orgId }, isDemo: false }, select: { phoneE164: true } });
  return new Set(rows.map((r) => r.phoneE164));
}

export interface SheetSyncResult { skipped?: string; checkedRows?: number; imported?: Record<string, number> | null; rowsWithErrors?: number; error?: string }

/** Import rows not seen before, using the mapping the admin reviewed. Safe to run concurrently or repeatedly. */
export async function pollGoogleSheet(opts: { manual?: boolean } = {}): Promise<SheetSyncResult> {
  const conn = await getSheetConnection();
  if (!conn?.mapping || !conn.campaignId) return { skipped: "Not set up yet: preview and import the sheet once first." };
  if (!opts.manual && !conn.autoSync) return { skipped: "Automatic sync is off." };
  let result: SheetSyncResult;
  try {
    const snap = await readChecked();
    const campaign = await db.campaign.findUniqueOrThrow({ where: { id: conn.campaignId } });
    const mapping = sheetMapping(snap.headers, conn.mapping as Mapping);
    const sheet: ParsedSheet = { headers: snap.headers, rows: snap.rows, warnings: snap.warnings };
    const preview = await buildPreview(sheet, mapping, SHEETS_SOURCE, conn.orgId);
    const elsewhere = await phonesOfOtherOrgs(conn.orgId, preview.map((r) => r.phoneE164!).filter(Boolean));
    const fresh = preview.filter((r) => (r.disposition === "new" || r.disposition === "merge_existing_phone" || r.disposition === "suppressed") && !elsewhere.has(r.phoneE164!));
    let imported: Record<string, number> | null = null;
    if (fresh.length) {
      const rows = fresh.map((r) => snap.rows[r.rowNumber - 2]);
      const batch = await db.importBatch.create({
        data: {
          fileName: `Google Sheet sync: ${snap.title}`.slice(0, 200), fileSha256: sha256(JSON.stringify([snap.headers, rows])), sourceSystem: SHEETS_SOURCE,
          mapping: mapping as Prisma.InputJsonValue, rows: { headers: snap.headers, rows, warnings: snap.warnings } as Prisma.InputJsonValue,
          campaignId: campaign.id, isDemo: config.mode === "demo" || campaign.isDemo, createdById: "system",
        },
      });
      imported = await commitBatch(batch.id, { id: null, orgId: conn.orgId });
    }
    result = { checkedRows: snap.rows.length, imported, rowsWithErrors: preview.filter((r) => r.disposition === "error").length };
    await db.sourceConnection.update({ where: { id: SHEETS_CONN_ID }, data: { lastSyncAt: new Date(), lastSummary: result as Prisma.InputJsonValue, lastError: null } });
  } catch (e) {
    result = { error: redactText((e as Error).message).slice(0, 500) };
    await db.sourceConnection.update({ where: { id: SHEETS_CONN_ID }, data: { lastSyncAt: new Date(), lastError: result.error } });
  }
  for (const t of config.googleSheets.extraTabs) await pollExtraTab(conn, t.gid);
  return result;
}

/** Lead source name for an extra tab, so a phone seen in both tabs keeps a record of each. */
export const tabSource = (gid: string) => `${SHEETS_SOURCE}:${gid}`;

/**
 * An extra tab (e.g. one recruiter's own leads) uses the main tab's reviewed
 * mapping and campaign. Its first read only remembers the rows already there,
 * so older leads in it are never called; rows added after that are imported.
 * A phone already known (e.g. from the main tab) is merged, not called again.
 */
async function pollExtraTab(main: { orgId: string; campaignId: string | null; mapping: Prisma.JsonValue }, gid: string) {
  const id = `${SHEETS_CONN_ID}:${gid}`;
  try {
    const snap = await readChecked(`gid:${gid}`);
    const mapping = sheetMapping(snap.headers, main.mapping as Mapping);
    const sheet: ParsedSheet = { headers: snap.headers, rows: snap.rows, warnings: snap.warnings };
    const preview = await buildPreview(sheet, mapping, tabSource(gid), main.orgId);
    const existing = await db.sourceConnection.findUnique({ where: { id } });
    const baseline = new Set(((existing?.mapping as { baseline?: string[] } | null)?.baseline) ?? []);
    if (!existing) {
      // First look at this tab: remember what is already there and import nothing.
      const ids = preview.map((r) => r.sourceRecordId).filter(Boolean);
      await db.sourceConnection.create({ data: { id, orgId: main.orgId, campaignId: main.campaignId, mapping: { baseline: ids }, lastSyncAt: new Date(), lastSummary: { baselineRows: ids.length } } });
      return;
    }
    const elsewhere = await phonesOfOtherOrgs(main.orgId, preview.map((r) => r.phoneE164!).filter(Boolean));
    const fresh = preview.filter((r) => !baseline.has(r.sourceRecordId) && !elsewhere.has(r.phoneE164!) && (r.disposition === "new" || r.disposition === "merge_existing_phone" || r.disposition === "suppressed"));
    let imported: Record<string, number> | null = null;
    if (fresh.length) {
      const rows = fresh.map((r) => snap.rows[r.rowNumber - 2]);
      const campaign = await db.campaign.findUniqueOrThrow({ where: { id: main.campaignId! } });
      const batch = await db.importBatch.create({
        data: {
          fileName: `Google Sheet sync: ${snap.title}`.slice(0, 200), fileSha256: sha256(JSON.stringify([snap.headers, rows])), sourceSystem: tabSource(gid),
          mapping: mapping as Prisma.InputJsonValue, rows: { headers: snap.headers, rows, warnings: snap.warnings } as Prisma.InputJsonValue,
          campaignId: campaign.id, isDemo: config.mode === "demo" || campaign.isDemo, createdById: "system",
        },
      });
      imported = await commitBatch(batch.id, { id: null, orgId: main.orgId });
    }
    await db.sourceConnection.update({ where: { id }, data: { lastSyncAt: new Date(), lastSummary: { checkedRows: snap.rows.length, imported } as Prisma.InputJsonValue, lastError: null } });
  } catch (e) {
    const msg = redactText((e as Error).message).slice(0, 500);
    await db.sourceConnection.updateMany({ where: { id }, data: { lastSyncAt: new Date(), lastError: msg } });
  }
}

/**
 * Called by the worker every few seconds; enqueues at most one poll per interval.
 * "Every 1 minute" reads every 5 seconds: recruiters claim a lead out of the Pool
 * tab within a minute or two, and a row gone from the Pool is never seen.
 */
export async function scheduleSheetPoll(now = Date.now()) {
  const conn = await getSheetConnection();
  if (!conn?.autoSync) return;
  const mins = Math.min(Math.max(conn.pollMinutes, 1), 60);
  const ms = mins === 1 ? SHEET_FAST_POLL_MS : mins * 60_000;
  await enqueue("source.google-sheets.poll", {}, { idempotencyKey: `gsheets:${ms}:${Math.floor(now / ms)}`, maxAttempts: 1 });
}

// Each read is one Google request per Pool tab (tab names are cached), so the main
// Pool, an extra tab and a team's Pool stay well under Google's 60 reads a minute.
export const SHEET_FAST_POLL_MS = 5_000;

/** Write the candidate's current progress to the sheet row, when write-back is enabled. */
export async function writeBackLeadStatus(leadId: string) {
  const src = getAdapters().sheets;
  const lead = await db.lead.findUnique({ where: { id: leadId }, include: { sourceRecords: { where: { sourceSystem: SHEETS_SOURCE } } } });
  if (!lead) return;
  const phoneColumn = ((await getSheetConnection())?.mapping as Mapping | null)?.phone;
  for (const r of lead.sourceRecords) {
    if (!src.statusColumn) { await db.leadSourceRecord.update({ where: { id: r.id }, data: { syncStatus: "WRITE_BACK_OFF" } }); continue; }
    const res = await src.writeStatus(r.sourceRecordId, SHEET_STATUS_LABEL[lead.pipelineStatus], phoneColumn);
    await db.leadSourceRecord.update({ where: { id: r.id }, data: { syncStatus: res === "written" ? "SYNCED" : res.toUpperCase(), lastSyncedAt: new Date() } });
  }
}
