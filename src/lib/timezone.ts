import { DateTime } from "luxon";
import { timezoneFromPhone } from "./area-codes";

// State -> IANA timezones. States spanning several zones are ambiguous and
// need a ZIP-level or manual resolution before automatic calling.
const STATE_TZ: Record<string, string[]> = {
  AL: ["America/Chicago"], AK: ["America/Anchorage", "America/Adak"], AZ: ["America/Phoenix"],
  AR: ["America/Chicago"], CA: ["America/Los_Angeles"], CO: ["America/Denver"], CT: ["America/New_York"],
  DE: ["America/New_York"], DC: ["America/New_York"], FL: ["America/New_York", "America/Chicago"],
  GA: ["America/New_York"], HI: ["Pacific/Honolulu"], ID: ["America/Boise", "America/Los_Angeles"],
  IL: ["America/Chicago"], IN: ["America/Indiana/Indianapolis", "America/Chicago"], IA: ["America/Chicago"],
  KS: ["America/Chicago", "America/Denver"], KY: ["America/New_York", "America/Chicago"],
  LA: ["America/Chicago"], ME: ["America/New_York"], MD: ["America/New_York"], MA: ["America/New_York"],
  MI: ["America/Detroit", "America/Menominee"], MN: ["America/Chicago"], MS: ["America/Chicago"],
  MO: ["America/Chicago"], MT: ["America/Denver"], NE: ["America/Chicago", "America/Denver"],
  NV: ["America/Los_Angeles"], NH: ["America/New_York"], NJ: ["America/New_York"], NM: ["America/Denver"],
  NY: ["America/New_York"], NC: ["America/New_York"], ND: ["America/Chicago", "America/Denver"],
  OH: ["America/New_York"], OK: ["America/Chicago"], OR: ["America/Los_Angeles", "America/Boise"],
  PA: ["America/New_York"], RI: ["America/New_York"], SC: ["America/New_York"],
  SD: ["America/Chicago", "America/Denver"], TN: ["America/Chicago", "America/New_York"],
  TX: ["America/Chicago", "America/Denver"], UT: ["America/Denver"], VT: ["America/New_York"],
  VA: ["America/New_York"], WA: ["America/Los_Angeles"], WV: ["America/New_York"],
  WI: ["America/Chicago"], WY: ["America/Denver"],
};

// Split states: majority zone, ZIP3 prefixes in another zone, and ZIP3s that
// straddle a boundary (must be resolved manually). Without a ZIP, split
// states are treated as ambiguous.
const SPLIT: Record<string, { major: string; exceptions: Record<string, string>; ambiguous: string[] }> = {
  TX: { major: "America/Chicago", exceptions: { "798": "America/Denver", "799": "America/Denver", "885": "America/Denver" }, ambiguous: [] },
  FL: { major: "America/New_York", exceptions: { "324": "America/Chicago", "325": "America/Chicago" }, ambiguous: [] },
  IN: { major: "America/Indiana/Indianapolis", exceptions: { "463": "America/Chicago", "464": "America/Chicago", "476": "America/Chicago", "477": "America/Chicago" }, ambiguous: [] },
  KY: { major: "America/New_York", exceptions: { "420": "America/Chicago", "421": "America/Chicago", "422": "America/Chicago", "423": "America/Chicago", "424": "America/Chicago" }, ambiguous: [] },
  TN: { major: "America/Chicago", exceptions: { "373": "America/New_York", "374": "America/New_York", "376": "America/New_York", "377": "America/New_York", "378": "America/New_York", "379": "America/New_York" }, ambiguous: [] },
  MI: { major: "America/Detroit", exceptions: {}, ambiguous: ["498", "499"] },
  KS: { major: "America/Chicago", exceptions: {}, ambiguous: ["677", "678", "679"] },
  NE: { major: "America/Chicago", exceptions: { "691": "America/Denver", "693": "America/Denver" }, ambiguous: ["690"] },
  ND: { major: "America/Chicago", exceptions: {}, ambiguous: ["586", "588"] },
  SD: { major: "America/Chicago", exceptions: { "577": "America/Denver" }, ambiguous: ["576"] },
  OR: { major: "America/Los_Angeles", exceptions: {}, ambiguous: ["979"] },
  ID: { major: "America/Boise", exceptions: { "835": "America/Los_Angeles", "838": "America/Los_Angeles" }, ambiguous: [] },
  AK: { major: "America/Anchorage", exceptions: {}, ambiguous: [] },
};

export const US_STATES = Object.keys(STATE_TZ);

export function resolveTimezone(state?: string | null, zip?: string | null): { timezone: string | null; source: string | null; ambiguous: boolean } {
  const z = zip?.trim().match(/^\d{5}/) ? zip.trim().slice(0, 3) : null;
  const st = state?.trim().toUpperCase();
  if (!st || !STATE_TZ[st]) return { timezone: null, source: null, ambiguous: false };
  const zones = STATE_TZ[st];
  if (zones.length === 1) return { timezone: zones[0], source: "STATE", ambiguous: false };
  const split = SPLIT[st];
  if (!split || !z || split.ambiguous.includes(z)) return { timezone: null, source: null, ambiguous: true };
  return { timezone: split.exceptions[z] ?? split.major, source: "ZIP", ambiguous: false };
}

/** The zone most of a state is in. */
export function mainZone(state: string): string | null {
  const st = state.toUpperCase();
  return SPLIT[st]?.major ?? STATE_TZ[st]?.[0] ?? null;
}

/** State/ZIP first; when they are missing or ambiguous, an approximate zone from the phone's area code. */
export function resolveTimezoneWithPhone(state: string | null | undefined, zip: string | null | undefined, phoneE164: string) {
  const r = resolveTimezone(state, zip);
  if (r.timezone) return r;
  const tz = timezoneFromPhone(phoneE164, mainZone);
  return tz ? { timezone: tz, source: "PHONE_AREA_CODE", ambiguous: false } : r;
}

export function isValidTimezone(tz: string) {
  return DateTime.now().setZone(tz).isValid;
}

export interface ContactWindow { start: string; end: string; days: number[] }

export function parseWindow(start: string, end: string, days: string): ContactWindow {
  return { start, end, days: days.split(",").map((d) => parseInt(d, 10)).filter((d) => d >= 1 && d <= 7) };
}

function hm(s: string) { const [h, m] = s.split(":").map(Number); return { hour: h, minute: m || 0 }; }

export function isWithinWindow(now: Date, tz: string, w: ContactWindow): boolean {
  const local = DateTime.fromJSDate(now).setZone(tz);
  if (!w.days.includes(local.weekday)) return false;
  const s = local.set({ ...hm(w.start), second: 0, millisecond: 0 });
  const e = local.set({ ...hm(w.end), second: 0, millisecond: 0 });
  return local >= s && local < e;
}

/** Next instant (>= now) when the driver-local window is open. */
export function nextWindowStart(now: Date, tz: string, w: ContactWindow): Date {
  if (isWithinWindow(now, tz, w)) return now;
  let local = DateTime.fromJSDate(now).setZone(tz);
  for (let i = 0; i < 8; i++) {
    const s = local.set({ ...hm(w.start), second: 0, millisecond: 0 });
    if (w.days.includes(s.weekday) && s > DateTime.fromJSDate(now)) return s.toJSDate();
    local = local.plus({ days: 1 }).startOf("day");
  }
  return DateTime.fromJSDate(now).plus({ days: 1 }).toJSDate();
}

export function formatLocal(d: Date, tz?: string | null) {
  const dt = DateTime.fromJSDate(d).setZone(tz || "America/Chicago");
  return dt.toFormat("ccc LLL d, h:mm a ZZZZ");
}
