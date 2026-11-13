// Every application in a team's lead sheet: one row with an Applied time, in the Pool or in a
// recruiter's tab. "New leads" on the dashboards is counted from these, so the number for a
// day is exactly the rows the sheet has for that day (the Applied column, US Central), the
// way Ads Manager counts a lead on the day it came in. Crystal gets only the rows that pass
// through the Pool; a row the distributor puts straight into a recruiter's tab is still a
// new lead of that day, just not one of hers.
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { log } from "./redact";
import { APPLIED_HEADER, isOldApplication, parseApplied } from "./applied";
import { appliedIn, firstSource, leadOrigin } from "./new-leads";
import { isReachedStatus, sheetStatus } from "./sheet-rows";
import { LEAD_SEL, isTestDriver } from "./talked";

// Lead sources that are a lead sheet ("GOOGLE_SHEETS", "GOOGLE_SHEETS:<tab>", "GOOGLE_SHEETS@<team>"; import.ts SHEETS_SOURCE).
const SHEETS_SOURCE = "GOOGLE_SHEETS";
const HOUR = 3600_000;

export interface SheetApplicationIn { key: string; phoneE164: string | null; name: string | null; appliedAt: Date; tab: string; status: string }

// "S-1311", "T-1555", "A-1086": the lead boards' own ids.
const LEAD_ID = /^[A-Za-z]{1,4}-?\d{2,}$/;
const isPool = (tab: string) => /pool/i.test(tab);
const UNWORKED = new Set(["New", "No answer"]);

/**
 * The applications of one tab: every row with an Applied time. The id is the LeadID column
 * (the column before Applied when its header was wiped, as long as the cell looks like a
 * LeadID); a row without one is told apart by its phone, else its name, and the Applied time.
 */
export function applicationsOf(tab: string, headers: string[], rows: string[][], phoneOf: (raw: string) => string | null): SheetApplicationIn[] {
  const col = (re: RegExp) => headers.findIndex((h) => re.test(h.trim()));
  const appliedI = col(APPLIED_HEADER);
  if (appliedI < 0) return [];
  const named = col(/^lead ?id$/i), idI = named >= 0 ? named : appliedI - 1;
  const phoneI = col(/^phone$/i), statusI = col(/^status$/i);
  const nameI = col(/^(full |driver(?:'s)? )?name$/i), firstI = col(/^first ?name$/i), lastI = col(/^last ?name$/i);
  const out: SheetApplicationIn[] = [];
  for (const r of rows) {
    const appliedAt = parseApplied(r[appliedI]);
    if (!appliedAt) continue;
    const phoneE164 = phoneI >= 0 ? phoneOf(r[phoneI] ?? "") : null;
    const name = (nameI >= 0 ? r[nameI] : [firstI >= 0 ? r[firstI] ?? "" : "", lastI >= 0 ? r[lastI] ?? "" : ""].join(" "))?.trim().slice(0, 120) || null;
    const id = idI >= 0 ? (r[idI] ?? "").trim() : "";
    const who = id && (named >= 0 || LEAD_ID.test(id)) ? id : phoneE164 ?? name?.toLowerCase();
    if (!who) continue;
    const key = (who === id ? id : `${who}|${appliedAt.toISOString()}`).slice(0, 190);
    out.push({ key, phoneE164, name, appliedAt, tab: tab.slice(0, 100), status: statusI >= 0 ? sheetStatus(r[statusI]) : "New" });
  }
  return out;
}

/** One row per application: a recruiter's tab wins over the Pool, a worked status over New / No answer. */
export function onePerApplication(rows: SheetApplicationIn[]) {
  const by = new Map<string, SheetApplicationIn>();
  for (const r of rows) {
    const o = by.get(r.key);
    const better = !o || (isPool(o.tab) && !isPool(r.tab)) || (isPool(o.tab) === isPool(r.tab) && UNWORKED.has(o.status) && !UNWORKED.has(r.status));
    if (better) by.set(r.key, { ...r, phoneE164: r.phoneE164 ?? o?.phoneE164 ?? null, name: r.name || o?.name || null });
  }
  return [...by.values()];
}

const counted = (a: { phoneE164: string | null; name: string | null }) => !isTestDriver(a.name, a.phoneE164);

/**
 * Makes one team's saved applications the same as its sheet. `complete` false (a tab could
 * not be read) only adds and updates, so a failed read never drops a day's leads. `now` is
 * when the reading began: a lead the site got later may not have its row saved yet.
 */
export async function saveSheetApplications(orgId: string, rows: SheetApplicationIn[], complete: boolean, now = new Date()) {
  // Owner tests and Facebook's test leads are not drivers: they are left out of every count.
  const fresh = onePerApplication(rows).filter(counted);
  const old = new Map((await db.sheetApplication.findMany({ where: { orgId } })).map((r) => [r.key, r]));
  const added = fresh.filter((r) => !old.has(r.key));
  for (let i = 0; i < added.length; i += 500) await db.sheetApplication.createMany({ data: added.slice(i, i + 500).map((r) => ({ orgId, ...r, seenAt: now })), skipDuplicates: true });
  for (const r of fresh) {
    const o = old.get(r.key);
    if (!o || (o.tab === r.tab && o.status === r.status && o.name === r.name && o.phoneE164 === r.phoneE164 && o.appliedAt.getTime() === r.appliedAt.getTime())) continue;
    await db.sheetApplication.update({ where: { id: o.id }, data: { ...r, seenAt: now } });
  }
  if (!complete) return fresh.length;
  const keep = new Set(fresh.map((r) => r.key));
  const gone = [...old.values()].filter((r) => !keep.has(r.key)).map((r) => r.id);
  // A sheet does not lose half of its rows between two readings: that is a bad read, and nothing is dropped.
  if (gone.length > 20 && gone.length > old.size / 2) {
    log.warn("lead sheet reading has far fewer rows than before: kept the saved ones", { orgId, read: fresh.length, saved: old.size });
    return fresh.length;
  }
  for (let i = 0; i < gone.length; i += 500) await db.sheetApplication.deleteMany({ where: { id: { in: gone.slice(i, i + 500) } } });
  await db.organization.update({ where: { id: orgId }, data: { sheetReadAt: now } });
  return fresh.length;
}

/** What the dashboards need of the lead behind a new lead. */
export const COHORT_LEAD = { ...LEAD_SEL, ...firstSource, pipelineStatus: true, documentStatus: true, hireStage: true } satisfies Prisma.LeadSelect;
export type CohortLead = Prisma.LeadGetPayload<{ select: typeof COHORT_LEAD }>;

/**
 * Why Crystal did not get an application as a new lead: it went straight into a recruiter's
 * tab; the driver was another team's first (a driver stays with the first team, sheets-sync.ts);
 * the driver applied again and she already had them; it applied before she started with the
 * team; the row is still in the Pool (an old row waiting for its turn); it has no valid phone.
 */
export type NotCrystal = "straight" | "other_team" | "again" | "before" | "pool" | "no_phone";

export interface NewLead {
  key: string; orgId: string; phoneE164: string | null; name: string | null; appliedAt: Date;
  /** The sheet tab and status now; null for a lead no sheet row stands for. */
  tab: string | null; status: string | null;
  /** The team's lead with this phone, if the site has one. */
  lead: CohortLead | null;
  /** Crystal got this application as a new lead (it came through the Pool). */
  crystal: boolean;
  /** Why not, when she did not. */
  why: NotCrystal | null;
}

type Range = { gte: Date; lt: Date };

/** The site lead was created from this application: a new applicant that reached the site within 3 days of applying. */
function cameAsNew(lead: CohortLead, appliedAt: Date) {
  return leadOrigin(lead) === "applicant" && lead.createdAt.getTime() >= appliedAt.getTime() - HOUR && !isOldApplication(appliedAt, lead.createdAt);
}

/**
 * The new leads of a period, newest first. A team whose lead sheet is read has exactly its
 * sheet's rows with an Applied time in the period: a lead that is not in the sheet (a test of
 * another lead form, a row somebody deleted) is not a new lead there. The one exception is a
 * lead Crystal got from the sheet after the last reading began: it is counted from the lead
 * until the next reading (15 minutes at most) sees its row. A team without a sheet has its own
 * new applicants. `scope` is the dashboards' lead filter (talked.ts).
 */
export async function newLeadsIn(orgIds: string[], scope: Prisma.LeadWhereInput, range: Range): Promise<NewLead[]> {
  const [apps, applicants, orgs, firstLeads] = await Promise.all([
    db.sheetApplication.findMany({ where: { orgId: { in: orgIds }, appliedAt: range } }).then((x) => x.filter(counted)),
    db.lead.findMany({ where: { AND: [scope, appliedIn(range)] }, select: COHORT_LEAD }).then((x) => x.filter((l) => leadOrigin(l) === "applicant")),
    db.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, sheetReadAt: true } }),
    db.lead.groupBy({ by: ["orgId"], where: scope, _min: { createdAt: true } }),
  ]);
  const appPhones = [...new Set(apps.map((a) => a.phoneE164).filter((p): p is string => !!p))];
  const applicantPhones = [...new Set(applicants.map((l) => l.phoneE164))];
  const [leads, inSheet] = await Promise.all([
    appPhones.length ? db.lead.findMany({ where: { AND: [scope, { phoneE164: { in: appPhones } }] }, select: COHORT_LEAD }) : [],
    applicantPhones.length ? db.sheetApplication.findMany({ where: { orgId: { in: orgIds }, phoneE164: { in: applicantPhones } }, select: { orgId: true, phoneE164: true } }) : [],
  ]);
  const at = (orgId: string, phone: string) => `${orgId}|${phone}`;
  const leadOf = new Map(leads.map((l) => [at(l.orgId, l.phoneE164), l]));
  const sheetHas = new Set(inSheet.map((a) => at(a.orgId, a.phoneE164!)));
  const mine = apps.map((a) => {
    const lead = a.phoneE164 ? leadOf.get(at(a.orgId, a.phoneE164)) ?? null : null;
    return { a, lead, crystal: !!lead && cameAsNew(lead, a.appliedAt) };
  });

  // Why the others did not reach Crystal as new leads.
  const loose = [...new Set(mine.filter((m) => !m.crystal && m.a.phoneE164).map((m) => m.a.phoneE164!))];
  const everywhere = loose.length ? await db.lead.findMany({ where: { phoneE164: { in: loose } }, select: { orgId: true, phoneE164: true, createdAt: true } }) : [];
  const startOf = new Map(firstLeads.map((g) => [g.orgId, g._min.createdAt]));
  const why = (a: (typeof apps)[number], lead: CohortLead | null): NotCrystal => {
    const t = a.appliedAt.getTime();
    if (lead && lead.createdAt.getTime() < t - HOUR) return "again";
    if (everywhere.some((o) => o.phoneE164 === a.phoneE164 && o.orgId !== a.orgId && o.createdAt.getTime() < t + HOUR)) return "other_team";
    const start = startOf.get(a.orgId);
    if (!start || t < start.getTime()) return "before";
    if (!a.phoneE164) return "no_phone";
    return !lead && isPool(a.tab) ? "pool" : "straight";
  };
  const rows: NewLead[] = mine.map(({ a, lead, crystal }) => (
    { key: a.id, orgId: a.orgId, phoneE164: a.phoneE164, name: a.name, appliedAt: a.appliedAt, tab: a.tab, status: a.status, lead, crystal, why: crystal ? null : why(a, lead) }
  ));

  const readAt = new Map(orgs.map((o) => [o.id, o.sheetReadAt]));
  for (const l of applicants) {
    if (sheetHas.has(at(l.orgId, l.phoneE164))) continue; // a sheet row stands for this driver, on the day that row applied
    const read = readAt.get(l.orgId);
    if (read && !(l.sourceRecords[0]?.sourceSystem.startsWith(SHEETS_SOURCE) && l.createdAt > read)) continue;
    rows.push({ key: `lead:${l.id}`, orgId: l.orgId, phoneE164: l.phoneE164, name: null, appliedAt: l.appliedAt ?? l.createdAt, tab: null, status: null, lead: l, crystal: true, why: null });
  }
  return rows.sort((a, b) => b.appliedAt.getTime() - a.appliedAt.getTime());
}

/** How many new leads a period had (the same rule as newLeadsIn). */
export async function countNewLeads(orgIds: string[], scope: Prisma.LeadWhereInput, range: Range) {
  return (await newLeadsIn(orgIds, scope, range)).length;
}

/** A recruiter reached the driver (the sheet status), or for a lead without a sheet row the status the site holds. */
export const reachedByRecruiter = (n: NewLead) => isReachedStatus(n.status ?? n.lead?.recruiterStatus ?? "New");
