// Which leads are new applicants. A lead is also created when Crystal re-calls an old
// "No answer" sheet driver (sheet-recall), picks an old lead (revive) or a driver gives a
// friend's number (referral). Those are not new applicants, so the dashboards leave them out
// of "New leads" and the talked rate. What created a lead is its first source record; a later
// re-call or revive of an existing applicant does not change the day it applied.
import { RECALL_PREFIX } from "./sheet-recall";

export const REVIVE_PREFIX = "revive:";
export const REFERRAL_PREFIX = "referral:";

export type LeadOrigin = "applicant" | "recall" | "revive" | "referral";
type WithSources = { sourceRecords: { sourceRecordId: string }[] };

/** Select this on a lead to know what created it. */
export const firstSource = { sourceRecords: { orderBy: { createdAt: "asc" as const }, take: 1, select: { sourceRecordId: true } } };

export function leadOrigin(lead: WithSources): LeadOrigin {
  const id = lead.sourceRecords[0]?.sourceRecordId ?? "";
  if (id.startsWith(RECALL_PREFIX)) return "recall";
  if (id.startsWith(REVIVE_PREFIX)) return "revive";
  if (id.startsWith(REFERRAL_PREFIX)) return "referral";
  return "applicant";
}

export const isNewApplicant = (lead: WithSources) => leadOrigin(lead) === "applicant";
