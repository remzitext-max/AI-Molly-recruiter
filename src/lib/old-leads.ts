// Old leads that come back through the Pool. A recruiter can send a driver back to the Pool
// ("Return to pool") weeks or months after they applied. To the site the row looks new, but
// the driver is not a new applicant: Crystal takes such rows under the old-leads rules (the
// Old leads page): only while the team has old leads switched on, not under 1 year of
// experience, and no more a day than the team's old-leads number, which they share with the
// drivers she picks herself. Rows that do not fit today stay in the Pool and are looked at
// again on the next read, so a recruiter who claims one simply takes it over.
import { DateTime } from "luxon";
import { db } from "./db";
import { isOldApplication, parseApplied } from "./applied";

const PICK_ZONE = "America/Chicago";

/** `Lead.reviveFrom` of a driver who came back through the Pool (the others hold the sheet status they were picked with). */
export const RETURNED = "Returned to Pool";
/** Calls Crystal makes to an old lead, like her other follow-up rounds. */
export const OLD_LEAD_CALLS = 2;
export const LOW_EXPERIENCE = /less than|under 1|^\s*<\s*1|^\s*0\b|no experience|6 ?\+? ?months?|just got/i;

/**
 * Start of the day the daily numbers of old leads and "No answer" re-calls count from: the US
 * Central day, the same day the dashboards show. Crystal picks the day's drivers right after it
 * starts and calls them when the calling hours open, so the recruiters are at work when a driver
 * says yes (Remzi 2026-11-12; before that the day was UTC, so she picked at 6 PM Central).
 */
export function pickDayStart(now: Date) {
  return DateTime.fromJSDate(now).setZone(PICK_ZONE).startOf("day").toJSDate();
}

type PoolRow = { disposition: string; values: Record<string, string> };

/**
 * The Pool rows Crystal takes now: every new applicant, and the old leads that fit today.
 * `held` is how many old rows were left in the Pool; `waiting` of them only because today's
 * number is used up (they go first tomorrow, see waitingInPools).
 */
export async function admitPoolRows<T extends PoolRow>(orgId: string, campaign: { reviveEnabled: boolean; revivePerDay: number }, fresh: T[], now = new Date()): Promise<{ rows: T[]; held: number; waiting: number }> {
  const applied = new Map(fresh.map((r) => [r, parseApplied(r.values.applied)]));
  // A phone the site already has is merged, not called: only rows that would become a lead count.
  const old = fresh.filter((r) => r.disposition === "new" && isOldApplication(applied.get(r), now));
  if (!old.length) return { rows: fresh, held: 0, waiting: 0 };
  const on = campaign.reviveEnabled && campaign.revivePerDay > 0;
  const room = on ? Math.max(0, campaign.revivePerDay - (await db.lead.count({ where: { orgId, reviveAt: { gte: pickDayStart(now) } } }))) : 0;
  const fit = old.filter((r) => !LOW_EXPERIENCE.test(r.values.experience ?? ""))
    .sort((a, b) => applied.get(b)!.getTime() - applied.get(a)!.getTime()); // newest application first
  const take = new Set(fit.slice(0, room));
  const held = new Set(old.filter((r) => !take.has(r)));
  return { rows: fresh.filter((r) => !held.has(r)), held: held.size, waiting: on ? fit.length - take.size : 0 };
}

/**
 * Old rows waiting in a team's Pools for a place in the daily number (from the last read of each
 * Pool, at most an hour old). Crystal's own picking leaves them room, so a row a recruiter sent
 * back is not kept waiting behind the hundreds of old leads she could pick herself.
 */
export async function waitingInPools(orgId: string, now = new Date()) {
  const conns = await db.sourceConnection.findMany({ where: { orgId, lastSyncAt: { gte: new Date(now.getTime() - 3600_000) } }, select: { lastSummary: true } });
  return conns.reduce((n, c) => n + (Number((c.lastSummary as { oldRowsWaiting?: unknown } | null)?.oldRowsWaiting) || 0), 0);
}
