// Every morning each team's group gets, per recruiter, how many drivers sit in a status past
// the Board's limit (Remzi, 2026-11-25: recruiters see it themselves; the manager follows up).
import { DateTime } from "luxon";
import { db } from "./db";
import { config } from "./config";
import { enqueue } from "./jobs/queue";
import { loadBoard, BOARD_COLUMNS } from "./board";
import { sendTeamTelegram, telegramConfigured } from "./telegram";

const ZONE = "America/Chicago";
const HOUR = 9;
// The statuses a recruiter can move (Need teammate waits on another driver, Hired is done).
const WATCHED = ["New", "Call back", "Need to talk", "Need to bring", "Need approval", "Application"];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The morning message for one team, or null when the team has no recruiter tabs at all. */
export async function buildStuckReport(orgId: string, now = new Date()): Promise<string | null> {
  const { all } = await loadBoard({ id: "", role: "ADMIN" }, [orgId], undefined, now);
  if (!all.length) return null;
  const late = all.filter((d) => d.tone === "late" && WATCHED.includes(d.status));
  const rules = WATCHED.map((s) => BOARD_COLUMNS.find((c) => c.status === s)!).map((c) => `${c.status} ${c.rule.replace(/^\D+/, "")}`).join(", ");
  const head = `⏰ Stuck drivers this morning\n<i>Past the limit: ${esc(rules)}</i>`;
  if (!late.length) return `${head}\n\n✅ Nobody is stuck. Good job, team!`;
  const by = new Map<string, Map<string, number>>();
  for (const d of late) {
    const who = d.recruiter ?? "Pool (nobody took them)";
    const m = by.get(who) ?? new Map<string, number>();
    m.set(d.status, (m.get(d.status) ?? 0) + 1);
    by.set(who, m);
  }
  const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const lines = [...by.entries()].sort((a, b) => total(b[1]) - total(a[1]))
    .map(([who, m]) => `• <b>${esc(who)}</b>: ${WATCHED.filter((s) => m.has(s)).map((s) => `${m.get(s)} ${s}`).join(", ")}`);
  return [head, "", ...lines, "", `Total: ${late.length}. Details on the Board page.`].join("\n");
}

export async function sendStuckReport(orgId: string, now = new Date()) {
  if (!telegramConfigured()) return { sent: false };
  const text = await buildStuckReport(orgId, now);
  if (!text) return { sent: false };
  await sendTeamTelegram(orgId, text);
  return { sent: true };
}

/** Called by the worker every minute: queues each team's report at 9 AM US Central, Monday to Saturday. */
export async function scheduleStuckReports(now = new Date()) {
  if (config.mode !== "live") return;
  const t = DateTime.fromJSDate(now, { zone: ZONE });
  if (t.weekday === 7 || t.hour !== HOUR) return;
  const day = t.toISODate();
  for (const o of await db.organization.findMany({ select: { id: true } })) {
    await enqueue("notify.telegram-stuck", { orgId: o.id }, { idempotencyKey: `stuck:${o.id}:${day}`, maxAttempts: 3 });
  }
}
