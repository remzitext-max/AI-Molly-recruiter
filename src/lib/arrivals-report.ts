// Every Monday the company group gets the drivers who arrived at the office (arrivals sheet)
// but are still not Hired in the lead sheets: recruiters forget to mark them (Remzi, 2026-11-25).
import { DateTime } from "luxon";
import { config } from "./config";
import { enqueue } from "./jobs/queue";
import { arrivedLeads, arrivedNotHired, loadArrivals, monthlyArrivals } from "./arrivals";
import { sendTelegram, telegramConfigured } from "./telegram";

const ZONE = "America/Chicago";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Arrivals of the last 30 days; the last 2 are left out (orientation takes 2 days).
const BACK_DAYS = 30, GRACE_DAYS = 2;

export async function buildArrivalsReport(now = DateTime.now().setZone(ZONE)): Promise<string | null> {
  const a = await loadArrivals(now);
  if ("error" in a) throw new Error(`Arrivals sheet: ${a.error}`);
  const from = now.minus({ days: BACK_DAYS }).toISODate()!, to = now.minus({ days: GRACE_DAYS }).toISODate()!;
  const list = await arrivedNotHired(a.bookings, from, to, a.extra);
  const head = `📋 Arrived at the office but not Hired in the lead sheet\n<i>Arrived ${DateTime.fromISO(from).toFormat("MMM d")} – ${DateTime.fromISO(to).toFormat("MMM d")}; please set Hired (or the real status) in the sheet</i>`;
  if (!list.length) return `${head}\n\n✅ None: every arrived driver of ours is marked.`;
  const lines = list.map((d) => `• ${esc(d.name)} · arrived ${DateTime.fromISO(d.day).toFormat("MMM d")} · ${esc(d.recruiter)} · ${esc(d.team)}, ${esc(d.tab)} tab: <b>${esc(d.status)}</b>`);
  let text = `${head}\n`;
  for (const [i, l] of lines.entries()) {
    if (text.length + l.length > 3800) { text += `\n…and ${lines.length - i} more`; break; }
    text += `\n${l}`;
  }
  return `${text}\n\nTotal: ${list.length}`;
}

export async function sendArrivalsReport() {
  if (!telegramConfigured()) return { sent: false };
  const text = await buildArrivalsReport();
  if (text) await sendTelegram(text);
  return { sent: !!text };
}

/** Called by the worker every minute: queues the report on Monday 9 AM US Central. */
export async function scheduleArrivalsReport(now = new Date()) {
  if (config.mode !== "live") return;
  const t = DateTime.fromJSDate(now, { zone: ZONE });
  if (t.weekday !== 1 || t.hour !== 9) return;
  await enqueue("notify.telegram-arrivals", {}, { idempotencyKey: `arrivals:${t.toISODate()}`, maxAttempts: 3 });
}



/** Last month's arrivals of our leads (the office's ARRIVED), for the 1st of the month. */
export async function buildMonthlyArrivals(now = DateTime.now().setZone(ZONE)): Promise<string> {
  const a = await loadArrivals(now);
  if ("error" in a) throw new Error(`Arrivals sheet: ${a.error}`);
  const m = now.minus({ months: 1 }).startOf("month");
  const list = await arrivedLeads(a.bookings, m.toISODate()!, m.endOf("month").toISODate()!, a.extra);
  const [x] = monthlyArrivals(list);
  const head = `📅 ${m.toFormat("MMMM yyyy")}: our leads who arrived at the office`;
  if (!x) return `${head}\n\nNone.`;
  return [head, "", `Arrived: <b>${x.arrived}</b>`, `Arrived and Hired (lead sheet): ${x.hired}`, `Not marked Hired: ${x.notMarked}`,
    ...Object.entries(x.byTeam).map(([t, n]) => `• ${esc(t)}: ${n}`)].join("\n");
}

export async function sendMonthlyArrivals() {
  if (!telegramConfigured()) return { sent: false };
  await sendTelegram(await buildMonthlyArrivals());
  return { sent: true };
}

/** Called by the worker every minute: queues last month's report on the 1st, 9 AM US Central. */
export async function scheduleMonthlyArrivals(now = new Date()) {
  if (config.mode !== "live") return;
  const t = DateTime.fromJSDate(now, { zone: ZONE });
  if (t.day !== 1 || t.hour !== 9) return;
  await enqueue("notify.telegram-arrivals-month", {}, { idempotencyKey: `arrivals-month:${t.toISODate()}`, maxAttempts: 3 });
}
