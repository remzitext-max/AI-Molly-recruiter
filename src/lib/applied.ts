// When a driver applied: the lead sheet's "Applied" column. A driver who reaches Crystal days
// after applying (a recruiter sent the row back to the Pool, or an old list was imported) is
// an old lead, not a new applicant.
import { DateTime } from "luxon";

// The sheet's "Applied" times are US Central.
const SHEET_ZONE = "America/Chicago";
const FORMATS = ["M/d/yyyy H:mm:ss", "M/d/yyyy H:mm", "M/d/yyyy h:mm:ss a", "M/d/yyyy h:mm a", "M/d/yyyy", "yyyy-MM-dd H:mm:ss", "yyyy-MM-dd H:mm", "yyyy-MM-dd"];

export const APPLIED_HEADER = /^applied/i;

export function parseApplied(v: string | undefined | null): Date | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  for (const f of FORMATS) {
    const d = DateTime.fromFormat(s, f, { zone: SHEET_ZONE });
    if (d.isValid) return d.toJSDate();
  }
  const iso = DateTime.fromISO(s, { zone: SHEET_ZONE });
  if (iso.isValid) return iso.toJSDate();
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** The lead board greys a row out as cold after 3 days; from then on the driver is an old lead for Crystal too. */
export const OLD_AFTER_DAYS = 3;

/** Applied 3+ days before reaching Crystal (`seenAt`). */
export function isOldApplication(appliedAt: Date | null | undefined, seenAt: Date) {
  return !!appliedAt && seenAt.getTime() - appliedAt.getTime() >= OLD_AFTER_DAYS * 86400_000;
}
