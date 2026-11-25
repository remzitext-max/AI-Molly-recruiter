// The office's arrivals sheet (HIREX DAILY DRIVERS UPDATE): who was booked to come to the
// office each day, who arrived, and what happened after (OFFICE MONITORING tab). Read only,
// with its own service account, at most every 15 minutes. Counted per recruiter name as the
// office writes it, so drivers recruiters bring themselves (not from leads) count too.
import { DateTime } from "luxon";
import { config } from "./config";
import { buildAssertion } from "../adapters/live/google-sheets";
import { providerFetch } from "../adapters/live/http";

const ZONE = "America/Chicago";
const DAILY_TAB = "DAILY DRIVERS UPDATE";
const OFFICE_TAB = "OFFICE MONITORING";
const CACHE_MS = 15 * 60_000;

export interface Booking { day: string; name: string; status: string; recruiter: string }
export interface OfficeRow { day: string; status: string; recruiter: string }
export interface ArrivalStats { recruiter: string; booked: number; arrived: number; noShow: number; coming: number; hitRoad: number; left: number; declined: number }

const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const cell = (r: unknown[], i: number) => (i >= 0 ? String(r[i] ?? "").trim() : "");
/** "DAVID", "Ayla ", "ALEX P" -> "David", "Ayla", "Alex P". */
export const recruiterName = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

/** The year of a "MM/DD" with no year: the one that matches the weekday when given, never far in the future. */
export function dayOf(month: number, day: number, now: DateTime, weekday?: string): string | null {
  const years = [now.year, now.year - 1, now.year + 1];
  const fits = years.map((y) => DateTime.fromObject({ year: y, month, day }, { zone: ZONE })).filter((d) => d.isValid && d <= now.plus({ days: 60 }));
  const byWeekday = weekday ? fits.find((d) => WEEKDAYS[d.weekday - 1] === weekday.slice(0, 3).toUpperCase()) : undefined;
  const pick = byWeekday ?? fits.filter((d) => d <= now.plus({ days: 1 })).sort((a, b) => +b - +a)[0] ?? fits[0];
  return pick?.toISODate() ?? null;
}

/** DAILY DRIVERS UPDATE: day header rows ("TUE 09/01"), then one row per booked driver. */
export function parseDaily(values: unknown[][], now: DateTime): Booking[] {
  const headerAt = values.findIndex((r) => r.some((c) => /^driver name$/i.test(String(c ?? "").trim())));
  if (headerAt < 0) return [];
  const h = values[headerAt].map((c) => String(c ?? "").trim().toLowerCase());
  const col = (re: RegExp) => h.findIndex((x) => re.test(x));
  const nameI = col(/^driver name$/), statusI = col(/^status$/), recI = col(/^recruiter$/), phoneI = col(/^number$|phone/);
  const out: Booking[] = [];
  let day: string | null = null;
  for (const r of values.slice(headerAt + 1)) {
    const head = r.map((c) => String(c ?? "").trim()).map((c) => /^(MON|TUE|WED|THU|FRI|SAT|SUN)[A-Z]*\.?\s+(\d{1,2})\/(\d{1,2})/i.exec(c)).find(Boolean);
    // A day header has no driver: its cells are empty or the merged date repeated.
    if (head && !/\d{3}\D*\d{4}/.test(cell(r, phoneI)) && (!cell(r, nameI) || head[0] === cell(r, nameI))) { day = dayOf(Number(head[2]), Number(head[3]), now, head[1]); continue; }
    const name = cell(r, nameI), recruiter = cell(r, recI);
    if (!day || !name || !recruiter) continue;
    out.push({ day, name, status: cell(r, statusI).toUpperCase(), recruiter: recruiterName(recruiter) });
  }
  return out;
}

/** OFFICE MONITORING: one row per arrived driver, "Arrived (date & time)" like "11/02 9:18 AM", and what happened. */
export function parseOffice(values: unknown[][], now: DateTime): OfficeRow[] {
  const h = (values[0] ?? []).map((c) => String(c ?? "").trim().toLowerCase());
  const col = (re: RegExp) => h.findIndex((x) => re.test(x));
  const arrI = col(/^arrived/), recI = col(/^recruiter$/), statusI = col(/^status$/);
  if (arrI < 0 || recI < 0) return [];
  const out: OfficeRow[] = [];
  for (const r of values.slice(1)) {
    const m = /^(\d{1,2})\/(\d{1,2})/.exec(cell(r, arrI));
    const recruiter = cell(r, recI);
    const day = m ? dayOf(Number(m[1]), Number(m[2]), now) : null;
    if (day && recruiter) out.push({ day, status: cell(r, statusI), recruiter: recruiterName(recruiter) });
  }
  return out;
}

/** Per recruiter for the days from..to (US Central ISO dates), most arrived first. */
export function arrivalStats(bookings: Booking[], office: OfficeRow[], from: string, to: string, today: string): ArrivalStats[] {
  const by = new Map<string, ArrivalStats>();
  const get = (recruiter: string) => by.get(recruiter) ?? by.set(recruiter, { recruiter, booked: 0, arrived: 0, noShow: 0, coming: 0, hitRoad: 0, left: 0, declined: 0 }).get(recruiter)!;
  for (const b of bookings) {
    if (b.day < from || b.day > to) continue;
    const s = get(b.recruiter);
    s.booked++;
    if (/ARRIV/.test(b.status)) s.arrived++;
    else if (b.day < today) s.noShow++;
    else s.coming++;
  }
  for (const o of office) {
    if (o.day < from || o.day > to) continue;
    const s = get(o.recruiter);
    if (/hit the road/i.test(o.status)) s.hitRoad++;
    else if (/declin/i.test(o.status)) s.declined++;
    else if (/left/i.test(o.status)) s.left++;
  }
  return [...by.values()].sort((a, b) => b.arrived - a.arrived || b.booked - a.booked || a.recruiter.localeCompare(b.recruiter));
}

let cache: { at: number; bookings: Booking[]; office: OfficeRow[] } | null = null;

async function token() {
  const a = config.arrivals;
  const scope = "https://www.googleapis.com/auth/spreadsheets.readonly";
  const res = await providerFetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: buildAssertion(a.serviceAccountEmail!, a.privateKey!, scope) }).toString(),
  });
  const j = (await res.json()) as { access_token?: string };
  if (!j.access_token) throw new Error("Google gave no access token");
  return j.access_token;
}

/** The sheet's bookings and office rows (cached 15 minutes), or why they can't be read. */
export async function loadArrivals(now = DateTime.now().setZone(ZONE)): Promise<{ bookings: Booking[]; office: OfficeRow[] } | { error: string }> {
  const a = config.arrivals;
  if (!a.serviceAccountEmail || !a.privateKey) return { error: "not set up (ARRIVALS_SERVICE_ACCOUNT_EMAIL / ARRIVALS_SERVICE_ACCOUNT_PRIVATE_KEY missing in .env)" };
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  try {
    const t = await token();
    const ranges = [`'${DAILY_TAB}'!A:Z`, `'${OFFICE_TAB}'!A:Z`].map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
    const res = await providerFetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(a.spreadsheetId)}/values:batchGet?${ranges}&majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`, { headers: { authorization: `Bearer ${t}` } });
    const j = (await res.json()) as { valueRanges?: { values?: unknown[][] }[] };
    const [daily, office] = j.valueRanges ?? [];
    cache = { at: Date.now(), bookings: parseDaily(daily?.values ?? [], now), office: parseOffice(office?.values ?? [], now) };
    return cache;
  } catch (e) {
    const msg = (e as Error).message;
    return { error: /403|PERMISSION|caller does not have/i.test(msg) ? `the sheet is not shared with ${a.serviceAccountEmail}` : msg.slice(0, 200) };
  }
}
