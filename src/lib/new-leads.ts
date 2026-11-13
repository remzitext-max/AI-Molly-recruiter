// Which leads are new applicants, and on which day. A lead is also created when Crystal
// re-calls an old "No answer" sheet driver (sheet-recall), picks an old lead (revive), a
// driver gives a friend's number (referral), or a recruiter sends an old row back to the Pool
// (old-leads.ts: it reaches Crystal days after the driver applied). Those are not new
// applicants, so the dashboards leave them out of "New leads" and the talked rate. What
// created a lead is its first source record; a later re-call or revive of an existing
// applicant does not change the day it applied. The day is the sheet's Applied time; when the
// sheet gave none, the time the lead reached the site.
import type { Prisma } from "@prisma/client";
import { RECALL_PREFIX } from "./sheet-recall";
import { isOldApplication } from "./applied";

export const REVIVE_PREFIX = "revive:";
export const REFERRAL_PREFIX = "referral:";

export type LeadOrigin = "applicant" | "recall" | "revive" | "referral" | "returned";
type WithSources = { sourceRecords: { sourceRecordId: string }[]; appliedAt: Date | null; createdAt: Date };

/** Select this on a lead to know what created it. */
export const firstSource = { appliedAt: true, createdAt: true, sourceRecords: { orderBy: { createdAt: "asc" as const }, take: 1, select: { sourceRecordId: true, sourceSystem: true } } };

export function leadOrigin(lead: WithSources): LeadOrigin {
  const id = lead.sourceRecords[0]?.sourceRecordId ?? "";
  if (id.startsWith(RECALL_PREFIX)) return "recall";
  if (id.startsWith(REVIVE_PREFIX)) return "revive";
  if (id.startsWith(REFERRAL_PREFIX)) return "referral";
  if (isOldApplication(lead.appliedAt, lead.createdAt)) return "returned";
  return "applicant";
}

export const isNewApplicant = (lead: WithSources) => leadOrigin(lead) === "applicant";

/** Leads that applied in the range (the sheet's Applied time, else when the lead reached the site). */
export function appliedIn(range: { gte: Date; lt: Date }): Prisma.LeadWhereInput {
  return { OR: [{ appliedAt: range }, { appliedAt: null, createdAt: range }] };
}
