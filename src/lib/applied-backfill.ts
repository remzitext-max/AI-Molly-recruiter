// One-time fill of Lead.appliedAt for the leads that reached the site before the column
// existed (queued once when the worker starts). The applied time comes from the sheet row the
// lead was imported from (the import batch keeps it), else from what a re-call or old-lead
// pick wrote down, else from the driver's row in the lead sheet when that row is the same
// application. A lead the automatic Pool reading brought in 3+ days after the driver applied
// was an old lead a recruiter sent back to the Pool: it is marked so, which moves it from
// "New leads" to "Old leads" on the day Crystal got it.
import { db } from "./db";
import { APPLIED_HEADER, OLD_AFTER_DAYS, isOldApplication, parseApplied } from "./applied";
import { normalizePhone } from "./phone";
import { RETURNED } from "./old-leads";

type Stored = { headers?: unknown; rows?: unknown };

function appliedFromBatch(batch: { mapping: unknown; rows: unknown }, raw: unknown, phoneE164: string): Date | null {
  const sheet = (batch.rows ?? {}) as Stored;
  const headers = Array.isArray(sheet.headers) ? (sheet.headers as unknown[]).map((h) => String(h ?? "")) : [];
  const rows = Array.isArray(sheet.rows) ? (sheet.rows as unknown[][]) : [];
  const appliedI = headers.findIndex((h) => APPLIED_HEADER.test(h.trim()));
  const phoneHeader = (batch.mapping as { phone?: string } | null)?.phone;
  const phoneI = phoneHeader ? headers.indexOf(phoneHeader) : -1;
  if (appliedI < 0 || phoneI < 0) return null;
  const mine = (r: unknown[] | undefined) => Array.isArray(r) && normalizePhone(String(r[phoneI] ?? "")) === phoneE164;
  const n = Number((raw as { row?: unknown } | null)?.row);
  const row = Number.isInteger(n) && mine(rows[n - 2]) ? rows[n - 2] : rows.find(mine);
  return row ? parseApplied(String(row[appliedI] ?? "")) : null;
}

export async function backfillApplied() {
  const leads = await db.lead.findMany({
    where: { appliedAt: null },
    select: { id: true, orgId: true, phoneE164: true, createdAt: true, reviveAt: true,
      sourceRecords: { orderBy: { createdAt: "asc" }, take: 1, select: { sourceRecordId: true, sourceSystem: true, importBatchId: true, raw: true } } },
  });
  const batchIds = [...new Set(leads.map((l) => l.sourceRecords[0]?.importBatchId).filter((x): x is string => !!x))];
  const batches = new Map<string, { mapping: unknown; rows: unknown; createdById: string }>();
  for (let i = 0; i < batchIds.length; i += 200) {
    for (const b of await db.importBatch.findMany({ where: { id: { in: batchIds.slice(i, i + 200) } }, select: { id: true, mapping: true, rows: true, createdById: true } })) batches.set(b.id, b);
  }
  const sheet = new Map((await db.sheetRow.findMany({ where: { appliedAt: { not: null } }, select: { orgId: true, phoneE164: true, appliedAt: true } })).map((r) => [`${r.orgId}|${r.phoneE164}`, r.appliedAt!]));
  let filled = 0, returned = 0;
  for (const l of leads) {
    const src = l.sourceRecords[0];
    const batch = src?.importBatchId ? batches.get(src.importBatchId) : undefined;
    let applied = batch ? appliedFromBatch(batch, src!.raw, l.phoneE164) : null;
    // A re-call or an old-lead pick wrote the sheet's applied time into its source record.
    const noted = (src?.raw as { applied?: unknown } | null)?.applied;
    if (!applied && typeof noted === "string" && !isNaN(new Date(noted).getTime())) applied = new Date(noted);
    // The driver's row in the lead sheet, when it is this application (the same phone can apply again later).
    const row = sheet.get(`${l.orgId}|${l.phoneE164}`);
    if (!applied && row && Math.abs(row.getTime() - l.createdAt.getTime()) < OLD_AFTER_DAYS * 86400_000) applied = row;
    // An application cannot be later than the lead it created (an hour's slack for clocks).
    if (!applied || applied.getTime() > l.createdAt.getTime() + 3600_000) continue;
    const cameBack = !l.reviveAt && batch?.createdById === "system" && !/^(recall|revive|referral):/.test(src?.sourceRecordId ?? "") && isOldApplication(applied, l.createdAt);
    await db.lead.update({ where: { id: l.id }, data: { appliedAt: applied, ...(cameBack ? { reviveAt: l.createdAt, reviveFrom: RETURNED } : {}) } });
    filled++;
    if (cameBack) returned++;
  }
  return { checked: leads.length, filled, returned };
}
