// The office's arrivals sheet (HIREX DAILY DRIVERS UPDATE): who was booked to come to the
// office each day, who arrived, and what happened after (OFFICE MONITORING tab). Read only,
// with its own service account, at most every 15 minutes. Counted per recruiter name as the
// office writes it, so drivers recruiters bring themselves (not from leads) count too.
import { DateTime } from "luxon";
import { config } from "./config";
import { buildAssertion } from "../adapters/live/google-sheets";
import { providerFetch } from "../adapters/live/http";
import { normalizePhone } from "./phone";
import { db } from "./db";

const ZONE = "America/Chicago";
const DAILY_TAB = "DAILY DRIVERS UPDATE";
const OFFICE_TAB = "OFFICE MONITORING";
const CACHE_MS = 15 * 60_000;

export interface Booking { day: string; name: string; status: string; recruiter: string; phone: string | null }
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
    out.push({ day, name, status: cell(r, statusI).toUpperCase(), recruiter: recruiterName(recruiter), phone: normalizePhone(cell(r, phoneI).split(/[\/,]/)[0]) });
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

/** A lead row of a board that is read only for statistics (no team on the site, nobody called). */
export interface BoardRow { orgId: string; phoneE164: string; tab: string; status: string; name: string | null }
/** Lead boards read only for these numbers: the Third team's (Remzi, 2026-11-25). */
export const STATS_BOARDS = [{ id: "1rCCQcpcpCNYHniI5EmPVkQD_wGtQR2c3WiTBcHLEalQ", team: "Third team" }];

/** One board's lead rows from every tab with a Phone header (Pool rows have no Status: "New"). */
export function parseBoardTab(values: unknown[][], team: string, tab: string): BoardRow[] {
  const hi = values.findIndex((r) => r.some((c) => /^phone$/i.test(String(c ?? "").trim())));
  if (hi < 0) return [];
  const h = values[hi].map((c) => String(c ?? "").trim().toLowerCase());
  const ni = h.indexOf("name"), pi = h.indexOf("phone"), ai = h.findIndex((x) => /^alt/.test(x)), si = h.indexOf("status");
  const out: BoardRow[] = [];
  for (const r of values.slice(hi + 1)) {
    for (const raw of [cell(r, pi), cell(r, ai)]) {
      const phone = normalizePhone(raw);
      if (phone) out.push({ orgId: `board:${team}`, phoneE164: phone, tab, status: cell(r, si) || "New", name: cell(r, ni) || null });
    }
  }
  return out;
}

let cache: { at: number; bookings: Booking[]; office: OfficeRow[]; extra: BoardRow[]; extraError: string | null } | null = null;

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
export async function loadArrivals(now = DateTime.now().setZone(ZONE)): Promise<{ bookings: Booking[]; office: OfficeRow[]; extra: BoardRow[]; extraError: string | null } | { error: string }> {
  const a = config.arrivals;
  if (!a.serviceAccountEmail || !a.privateKey) return { error: "no Google service account in .env" };
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  try {
    const t = await token();
    const ranges = [`'${DAILY_TAB}'!A:Z`, `'${OFFICE_TAB}'!A:Z`].map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
    const res = await providerFetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(a.spreadsheetId)}/values:batchGet?${ranges}&majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`, { headers: { authorization: `Bearer ${t}` } });
    const j = (await res.json()) as { valueRanges?: { values?: unknown[][] }[] };
    const [daily, office] = j.valueRanges ?? [];
    // The statistics-only boards: a failure there (not shared yet) must not hide the arrivals.
    let extra: BoardRow[] = [], extraError: string | null = null;
    for (const b of STATS_BOARDS) {
      try {
        const meta = await providerFetch(`https://sheets.googleapis.com/v4/spreadsheets/${b.id}?fields=sheets.properties.title`, { headers: { authorization: `Bearer ${t}` } });
        const tabs = (((await meta.json()) as { sheets?: { properties: { title: string } }[] }).sheets ?? []).map((x) => x.properties.title).filter((x) => !/how to use|teammates/i.test(x));
        const q = tabs.map((x) => `ranges=${encodeURIComponent(`'${x.replace(/'/g, "''")}'!A:Z`)}`).join("&");
        const v = (await (await providerFetch(`https://sheets.googleapis.com/v4/spreadsheets/${b.id}/values:batchGet?${q}&majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`, { headers: { authorization: `Bearer ${t}` } })).json()) as { valueRanges?: { values?: unknown[][] }[] };
        (v.valueRanges ?? []).forEach((r, i) => { extra.push(...parseBoardTab(r.values ?? [], b.team, tabs[i].replace(/^\W+\s*/, ""))); });
      } catch (e) {
        extraError = `${b.team} board can't be read (${/403|PERMISSION/i.test((e as Error).message) ? "not shared with the site's service account" : (e as Error).message.slice(0, 120)})`;
      }
    }
    cache = { at: Date.now(), bookings: parseDaily(daily?.values ?? [], now), office: parseOffice(office?.values ?? [], now), extra, extraError };
    return cache;
  } catch (e) {
    const msg = (e as Error).message;
    return { error: /403|PERMISSION|caller does not have/i.test(msg) ? "the sheet is not open to the site (share it with anyone with the link, or with the site's service account)" : msg.slice(0, 200) };
  }
}

export interface ArrivedNotHired { name: string; day: string; recruiter: string; team: string; tab: string; status: string }
const HIRED = /^(hired|our driver)/i;
const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Drivers the office marked ARRIVED on a day from..to (ISO) who are our leads (same phone, or
 * else the same full name, in a lead sheet) but whose sheet status is still not Hired: the
 * recruiter probably forgot to mark them. Drivers who are not our leads are left out.
 */
export async function arrivedNotHired(bookings: Booking[], from: string, to: string, extra: BoardRow[] = []): Promise<ArrivedNotHired[]> {
  return (await arrivedLeads(bookings, from, to, extra)).filter((d) => !d.hired);
}

export interface ArrivedLead extends ArrivedNotHired { hired: boolean }

/** Every driver the office marked ARRIVED on a day from..to who is our lead (same phone, else same full name), with whether the lead sheet says Hired. */
export async function arrivedLeads(bookings: Booking[], from: string, to: string, extra: BoardRow[] = []): Promise<ArrivedLead[]> {
  const arrived = bookings.filter((b) => /ARRIV/.test(b.status) && b.day >= from && b.day <= to);
  if (!arrived.length) return [];
  const phones = [...new Set(arrived.map((b) => b.phone).filter((p): p is string => !!p))];
  const [dbByPhone, dbAll, orgs] = await Promise.all([
    db.sheetRow.findMany({ where: { phoneE164: { in: phones } }, select: { orgId: true, phoneE164: true, tab: true, status: true, name: true } }),
    db.sheetRow.findMany({ where: { name: { not: null } }, select: { orgId: true, phoneE164: true, tab: true, status: true, name: true } }),
    db.organization.findMany({ select: { id: true, name: true } }),
  ]);
  const byPhone: BoardRow[] = [...dbByPhone, ...extra.filter((r) => phones.includes(r.phoneE164))];
  const all: BoardRow[] = [...dbAll, ...extra.filter((r) => r.name)];
  const team = new Map([...orgs.map((o) => [o.id, o.name] as const), ...STATS_BOARDS.map((b) => [`board:${b.team}`, b.team] as const)]);
  const byName = new Map<string, typeof all>();
  for (const r of all) { const k = nameKey(r.name!); if (k.includes(" ")) byName.set(k, [...(byName.get(k) ?? []), r]); }
  const out: ArrivedLead[] = [];
  const seen = new Set<string>();
  for (const b of arrived) {
    const rows = (b.phone ? byPhone.filter((r) => r.phoneE164 === b.phone) : []);
    const named = rows.length ? rows : (byName.get(nameKey(b.name)) ?? []);
    // One driver per phone; a name shared by two different phones is not guessed.
    const uniq = [...new Map(named.map((r) => [r.phoneE164, r])).values()];
    if (uniq.length !== 1 && !rows.length) continue;
    const hired = named.some((r) => HIRED.test(r.status));
    const r = named.find((x) => HIRED.test(x.status)) ?? named.find((x) => !/pool/i.test(x.tab)) ?? named[0];
    if (!r || seen.has(r.phoneE164)) continue;
    seen.add(r.phoneE164);
    out.push({ name: b.name, day: b.day, recruiter: b.recruiter, team: team.get(r.orgId) ?? "", tab: r.tab, status: r.status, hired });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

export interface MonthArrivals { month: string; arrived: number; hired: number; notMarked: number; byTeam: Record<string, number> }

/** Our leads who arrived at the office, per calendar month of the arrival day. */
export function monthlyArrivals(list: ArrivedLead[]): MonthArrivals[] {
  const by = new Map<string, MonthArrivals>();
  for (const d of list) {
    const m = d.day.slice(0, 7);
    const x = by.get(m) ?? by.set(m, { month: m, arrived: 0, hired: 0, notMarked: 0, byTeam: {} }).get(m)!;
    x.arrived++;
    if (d.hired) x.hired++; else x.notMarked++;
    x.byTeam[d.team] = (x.byTeam[d.team] ?? 0) + 1;
  }
  return [...by.values()].sort((a, b) => a.month.localeCompare(b.month));
}
