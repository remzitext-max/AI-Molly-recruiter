// Posts a driver card to the owner's Telegram chat after each answered AI call.
// Off unless TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set. Text only: never
// documents or license images.
import { config } from "./config";
import { db } from "./db";
import { providerFetch } from "../adapters/live/http";

const LABELS: Record<string, string> = {
  first_name: "Name",
  home_location: "Based in",
  cdl_class: "CDL class",
  endorsements: "Endorsements",
  restrictions: "Restrictions",
  experience_years: "Experience",
  equipment_experience: "Equipment",
  driving_type: "Solo/Team",
  route_preference: "Route",
  home_time: "Home time",
  start_date: "Can start",
  recent_miles: "Recent miles",
  weeks_out: "Weeks out",
  weekly_miles: "Miles/week",
  sap_history: "SAP",
  accidents_at_fault: "Accidents at fault",
  med_card_expiry: "Med card expires",
  offer_interest: "Interest",
  concerns: "Concerns",
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const human = (s: string) => s.toLowerCase().replace(/_/g, " ");

export function telegramConfigured() {
  return !!(config.telegram.botToken && config.telegram.chatId);
}

export async function sendTelegram(text: string, chatId = config.telegram.chatId) {
  const token = config.telegram.botToken;
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured");
  await providerFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
}

/** The card for one finished call, or null when there is nothing to report (not answered, demo record). */
export async function buildCallReport(attemptId: string): Promise<string | null> {
  const a = await db.callAttempt.findUnique({ where: { id: attemptId }, include: { lead: { include: { screening: true } } } });
  if (!a || a.lead.isDemo || !a.startedAt || a.status === "VOICEMAIL") return null;
  const l = a.lead;
  const name = [l.firstName, l.lastName].filter(Boolean).join(" ") || "Unknown";
  const secs = a.endedAt ? Math.max(0, Math.round((a.endedAt.getTime() - a.startedAt.getTime()) / 1000)) : null;
  const questions = await db.unansweredQuestion.findMany({ where: { callAttemptId: a.id }, orderBy: { createdAt: "asc" } });

  const lines = [
    `🚛 <b>${esc(name)}</b>`,
    `📞 ${esc(l.phoneE164)}`,
    `Outcome: <b>${esc(a.outcome ? human(a.outcome) : human(a.status))}</b>${secs !== null ? ` · ${Math.floor(secs / 60)}m ${secs % 60}s` : ""}`,
  ];
  const answers = l.screening
    .filter((f) => f.reportedValue && f.key !== "first_name")
    .sort((x, y) => Object.keys(LABELS).indexOf(x.key) - Object.keys(LABELS).indexOf(y.key));
  if (answers.length) {
    lines.push("", "<b>Answers</b>");
    for (const f of answers) lines.push(`• ${esc(LABELS[f.key] ?? human(f.key))}: ${esc(f.reportedValue!)}${f.status === "UNCLEAR" ? " (unclear)" : ""}`);
  }
  if (questions.length) {
    lines.push("", "<b>Questions for you</b>");
    for (const q of questions) lines.push(`• ${esc(q.question)}`);
  }
  if (a.summary) lines.push("", `<i>${esc(a.summary.slice(0, 1200))}</i>`);
  lines.push("", `${esc(config.appUrl)}/leads/${l.id}`);
  return lines.join("\n").slice(0, 4000);
}

export async function sendCallReport(attemptId: string) {
  if (!telegramConfigured()) return { sent: false, reason: "not configured" };
  const text = await buildCallReport(attemptId);
  if (!text) return { sent: false, reason: "nothing to report" };
  await sendTelegram(text);
  return { sent: true };
}
