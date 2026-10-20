// Posts a driver card to the owner's Telegram group after each answered AI call,
// and forwards each CDL / medical card file a driver uploads.
// Off unless TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set.
import { config } from "./config";
import { db } from "./db";
import { providerFetch } from "../adapters/live/http";
import { getAdapters } from "../adapters/registry";

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
    `💵Payment: asking: `,
    `🚛can drive: ${v(slot("weekly_miles"))}`,
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

/** Sends one uploaded driver file (CDL / medical card) to the group with the driver's name and phone. */
export async function sendDocumentToTelegram(documentId: string) {
  const token = config.telegram.botToken;
  const chatId = config.telegram.chatId;
  if (!token || !chatId) return { sent: false, reason: "not configured" };
  const d = await db.document.findUnique({ where: { id: documentId }, include: { lead: true } });
  if (!d || d.deletedAt || d.lead.isDemo) return { sent: false, reason: "nothing to send" };
  const data = await getAdapters().storage.get(d.storageKey);
  const name = [d.lead.firstName, d.lead.lastName].filter(Boolean).join(" ");
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("caption", `📎 CDL / medical card\n🗒 ${name}\n☎️ ${d.lead.phoneE164}`);
  form.set("document", new Blob([new Uint8Array(data)], { type: d.mimeType }), `${(name || "driver").replace(/[^A-Za-z0-9]+/g, "_")}.${d.storageKey.split(".").pop()}`);
  await providerFetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form, timeoutMs: 60000 });
  return { sent: true };
}
