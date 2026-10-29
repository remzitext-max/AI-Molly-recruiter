// When a team's recruiters are at work, in Tashkent time ("17:00-03:00" runs past midnight).
// Outside these hours Crystal does not transfer drivers: she books a time for a recruiter
// to call them back, and the recruiter is reminded in Telegram 5 minutes before.
import { DateTime } from "luxon";

export const OFFICE_ZONE = "Asia/Tashkent";
export const DEFAULT_OFFICE_HOURS = "17:00-03:00";

const minutes = (hm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

/** "17:00-03:00" -> start and end in minutes after midnight, or null when not that shape. */
export function parseOfficeHours(text: string | null | undefined): { start: number; end: number } | null {
  const [a, b] = (text ?? "").split("-");
  const start = a === undefined ? null : minutes(a);
  const end = b === undefined ? null : minutes(b);
  return start === null || end === null || start === end ? null : { start, end };
}

/** "5pm-3am", "17:00 - 3:00" -> "17:00-03:00"; empty -> null (always open); anything else -> undefined (invalid). */
export function normalizeOfficeHours(text: string | null | undefined): string | null | undefined {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return null;
  const parts = t.split(/\s*[-–]\s*|\s+to\s+/);
  if (parts.length !== 2) return undefined;
  const hm = parts.map((p) => {
    const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(p.trim());
    if (!m) return null;
    let h = Number(m[1]);
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    return h > 23 ? null : `${String(h).padStart(2, "0")}:${m[2] ?? "00"}`;
  });
  if (hm.some((x) => !x)) return undefined;
  const out = `${hm[0]}-${hm[1]}`;
  return parseOfficeHours(out) ? out : undefined;
}

/** Whether recruiters are at work now. No hours set means always. */
export function officeOpen(hours: string | null | undefined, now = new Date()): boolean {
  const h = parseOfficeHours(hours);
  if (!h) return true;
  const t = DateTime.fromJSDate(now).setZone(OFFICE_ZONE);
  const m = t.hour * 60 + t.minute;
  return h.start < h.end ? m >= h.start && m < h.end : m >= h.start || m < h.end;
}

/** The next time the office opens (now when it is open). */
export function nextOpening(hours: string | null | undefined, now = new Date()): Date {
  const h = parseOfficeHours(hours);
  if (!h || officeOpen(hours, now)) return now;
  const t = DateTime.fromJSDate(now).setZone(OFFICE_ZONE);
  let open = t.startOf("day").plus({ minutes: h.start });
  if (open <= t) open = open.plus({ days: 1 });
  return open.toJSDate();
}

/** "8 AM" / "7:30 AM" in the driver's time zone (Central when unknown). */
export function localClock(at: Date, tz: string | null | undefined): string {
  const t = DateTime.fromJSDate(at).setZone(tz || "America/Chicago");
  return t.toFormat(t.minute ? "h:mm a" : "h a");
}

/** "Oct 30, 9:00 AM" in Tashkent, for the recruiters. */
export function officeClock(at: Date): string {
  return DateTime.fromJSDate(at).setZone(OFFICE_ZONE).toFormat("LLL d, HH:mm");
}
