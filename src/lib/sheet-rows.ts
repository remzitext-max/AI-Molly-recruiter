// Every row of a team's lead sheet (phone, tab, status, applied date), kept so the
// dashboards and the Recruiters page count the recruiters' statuses the way the sheet
// shows them, Crystal's leads or not.
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { canonicalStatus, RECRUITER_STATUSES } from "./recruiter-status";
import { tabForUser } from "./assignment";
import { APPLIED_HEADER, parseApplied } from "./applied";

export { parseApplied };

export interface SheetRowIn { phoneE164: string; tab: string; status: string; appliedAt: Date | null; name?: string | null; experience?: string | null }

/** The sheet's spelling of a status; an empty cell is a new lead nobody has worked yet. */
export function sheetStatus(raw: string | undefined) {
  const s = (raw ?? "").trim();
  return s ? canonicalStatus(s) ?? s.slice(0, 100) : "New";
}

const isPool = (tab: string) => /pool/i.test(tab);
const UNWORKED = new Set(["New", "No answer"]);

/** The rows of one tab that have a phone. */
export function sheetRowsOf(tab: string, headers: string[], rows: string[][], phoneOf: (raw: string) => string | null): SheetRowIn[] {
  const col = (re: RegExp) => headers.findIndex((h) => re.test(h.trim()));
  const phoneI = col(/^phone$/i), statusI = col(/^status$/i), appliedI = col(APPLIED_HEADER);
  if (phoneI < 0 || statusI < 0) return [];
  const nameI = col(/^(full |driver(?:'s)? )?name$/i), firstI = col(/^first ?name$/i), lastI = col(/^last ?name$/i), expI = col(/experience/i);
  const out: SheetRowIn[] = [];
  for (const r of rows) {
    const phoneE164 = phoneOf(r[phoneI] ?? "");
    if (!phoneE164) continue;
    const name = (nameI >= 0 ? r[nameI] : [firstI >= 0 ? r[firstI] ?? "" : "", lastI >= 0 ? r[lastI] ?? "" : ""].join(" "))?.trim().slice(0, 120) || null;
    const experience = expI >= 0 ? r[expI]?.trim().slice(0, 120) || null : null;
    out.push({ phoneE164, tab: tab.slice(0, 100), status: sheetStatus(r[statusI]), appliedAt: appliedI >= 0 ? parseApplied(r[appliedI]) : null, name, experience });
  }
  return out;
}

/** One row per phone: a recruiter's tab wins over the Pool, a worked status over New / No answer. */
export function onePerPhone(rows: SheetRowIn[]) {
  const by = new Map<string, SheetRowIn>();
  for (const r of rows) {
    const o = by.get(r.phoneE164);
    const better = !o || (isPool(o.tab) && !isPool(r.tab)) || (isPool(o.tab) === isPool(r.tab) && UNWORKED.has(o.status) && !UNWORKED.has(r.status));
    if (better) by.set(r.phoneE164, { ...r, appliedAt: r.appliedAt ?? o?.appliedAt ?? null, name: r.name || o?.name || null, experience: r.experience || o?.experience || null });
  }
  return [...by.values()];
}

/** Replaces one team's rows with what its sheet shows now. Call only after a successful read. */
export async function saveSheetRows(orgId: string, rows: SheetRowIn[], now = new Date()) {
  const fresh = onePerPhone(rows);
  const old = new Map((await db.sheetRow.findMany({ where: { orgId } })).map((r) => [r.phoneE164, r]));
  for (const r of fresh) {
    const o = old.get(r.phoneE164);
    const data = { ...r, name: r.name ?? null, experience: r.experience ?? null };
    if (o && o.tab === r.tab && o.status === r.status && o.statusAt && o.name === data.name && o.experience === data.experience && (o.appliedAt?.getTime() ?? null) === (r.appliedAt?.getTime() ?? null)) continue;
    // A new row has had its status since it applied; a changed status starts now.
    const statusAt = !o ? r.appliedAt ?? now : o.status !== r.status ? now : o.statusAt ?? o.appliedAt ?? now;
    await db.sheetRow.upsert({ where: { orgId_phoneE164: { orgId, phoneE164: r.phoneE164 } }, create: { orgId, ...data, statusAt, seenAt: now }, update: { ...data, statusAt, seenAt: now } });
  }
  const keep = new Set(fresh.map((r) => r.phoneE164));
  const gone = [...old.keys()].filter((p) => !keep.has(p));
  if (gone.length) await db.sheetRow.deleteMany({ where: { orgId, phoneE164: { in: gone } } });
  return fresh.length;
}

/** Status columns in the sheet's own order, then any other spellings found. */
export function orderStatuses(found: Iterable<string>) {
  const set = new Set(found);
  return [...RECRUITER_STATUSES.filter((s) => set.has(s)), ...[...set].filter((s) => !(RECRUITER_STATUSES as readonly string[]).includes(s)).sort()];
}

export interface TabStats { orgId: string; tab: string; recruiter: string | null; recruiterId: string | null; total: number; byStatus: Record<string, number> }

/**
 * Rows per tab and status for leads that applied in the range, with the recruiter whose
 * tab it is (by name, or the tab set on Users). The Pool comes last. Counted from the sheet's
 * applications (one per LeadID, the Pool included), so the tabs add up to the dashboards'
 * "New leads" for the same dates.
 */
export async function tabStats(orgIds: string[], range?: { gte: Date; lt: Date }): Promise<TabStats[]> {
  const where: Prisma.SheetApplicationWhereInput = { orgId: { in: orgIds }, ...(range ? { appliedAt: range } : {}) };
  const [groups, users] = await Promise.all([
    db.sheetApplication.groupBy({ by: ["orgId", "tab", "status"], where, _count: true }),
    db.user.findMany({ where: { orgId: { in: orgIds }, active: true }, select: { id: true, name: true, sheetTab: true, orgId: true } }),
  ]);
  const out = new Map<string, TabStats>();
  for (const g of groups) {
    const k = `${g.orgId}|${g.tab.toLowerCase()}`;
    let t = out.get(k);
    if (!t) {
      const tabs = [...new Set(groups.filter((x) => x.orgId === g.orgId).map((x) => x.tab))];
      const owners = users.filter((u) => u.orgId === g.orgId && tabForUser(u, tabs)?.toLowerCase() === g.tab.toLowerCase());
      const owner = owners.length === 1 ? owners[0] : null;
      t = { orgId: g.orgId, tab: g.tab, recruiter: owner?.name ?? null, recruiterId: owner?.id ?? null, total: 0, byStatus: {} };
      out.set(k, t);
    }
    t.total += g._count;
    t.byStatus[g.status] = (t.byStatus[g.status] ?? 0) + g._count;
  }
  return [...out.values()].sort((a, b) => Number(isPool(a.tab)) - Number(isPool(b.tab)) || b.total - a.total);
}

/** Statuses that mean the recruiter reached the driver (anything but New / No answer / Not in service). */
export const isReachedStatus = (s: string) => !UNWORKED.has(s) && s !== "Not in service";
export const talkedBy = (t: TabStats) => Object.entries(t.byStatus).filter(([s]) => isReachedStatus(s)).reduce((n, [, c]) => n + c, 0);
export const countOf = (t: TabStats, ...statuses: string[]) => statuses.reduce((n, s) => n + (t.byStatus[s] ?? 0), 0);
