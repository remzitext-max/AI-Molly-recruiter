// Posts a driver card to the owner's Telegram chat after each answered AI call.
// Off unless TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set. Text only: never
// documents or license images.
import { config } from "./config";
import { db } from "./db";
import { providerFetch } from "../adapters/live/http";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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

/** The owner's driver card for one finished call, or null when there is nothing to report (not answered, voicemail, demo record). */
export async function buildCallReport(attemptId: string): Promise<string | null> {
  const a = await db.callAttempt.findUnique({ where: { id: attemptId }, include: { lead: { include: { screening: true } } } });
  if (!a || a.lead.isDemo || !a.startedAt || a.status === "VOICEMAIL") return null;
  const l = a.lead;
  const slot = (k: string) => l.screening.find((f) => f.key === k && f.reportedValue)?.reportedValue ?? "";
  const v = (s: string | null | undefined) => esc((s ?? "").trim());
  const team = /team/i.test(slot("driving_type"));
  return [
    `👔Recruiter: ${v(config.agentPersona.name)} AI`,
    `🥸Driver type: ${team ? "Team" : "Solo"}`,
    `🗒Driver name: ${v([l.firstName, l.lastName].filter(Boolean).join(" "))}`,
    `🌍State: ${v(l.state || slot("home_location"))}`,
    `🏠Home time: ${v(slot("home_time"))}`,
    `📈Experience: ${v(slot("experience_years"))}`,
    `💵Payment: asking: ${v(slot("pay_expectation"))}`,
    `🚛can drive: ${v(slot("transmission") || slot("restrictions"))}`,
    `🗣 English: ${v(slot("english_level"))}`,
    `✅ Ready date: ${v(slot("start_date"))}`,
    `☎️Phone number : ${v(l.phoneE164)}`,
  ].join("\n");
}

export async function sendCallReport(attemptId: string) {
  if (!telegramConfigured()) return { sent: false, reason: "not configured" };
  const text = await buildCallReport(attemptId);
  if (!text) return { sent: false, reason: "nothing to report" };
  await sendTelegram(text);
  return { sent: true };
}
