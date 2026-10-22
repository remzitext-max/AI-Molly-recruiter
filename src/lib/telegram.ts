// Posts a driver card to the owner's Telegram group after each AI call (a one-line note when nobody answered),
// and forwards each CDL / medical card file a driver uploads.
// Off unless TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set.
import { config } from "./config";
import { db } from "./db";
import { providerFetch } from "../adapters/live/http";
import { getAdapters } from "../adapters/registry";
import { recordingMime } from "./recordings";
import { getSettings } from "./settings";
import { answersOf, fitRulesFrom, fitScore, fitText } from "./fit-score";
import { endedByText, whoEnded } from "./call-end";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Up to two last things the driver said, for the short "nothing collected" note. */
function lastDriverLines(transcript: unknown): string[] {
  if (!Array.isArray(transcript)) return [];
  return (transcript as { speaker?: string; text?: string }[]).filter((t) => t.speaker === "driver" && t.text).slice(-2).map((t) => `🗣 Driver: "${esc(String(t.text).slice(0, 200))}"`);
}

/** "@user" lines for the recruiters whose sheet tab this lead came from (GOOGLE_SHEETS_EXTRA_TABS). */
export async function recruiterTags(leadId: string): Promise<string[]> {
  const tabs = config.googleSheets.extraTabs.filter((t) => t.tag);
  if (!tabs.length) return [];
  const recs = await db.leadSourceRecord.findMany({ where: { leadId, sourceSystem: { in: tabs.map((t) => `GOOGLE_SHEETS:${t.gid}`) } }, select: { sourceSystem: true } });
  return [...new Set(tabs.filter((t) => recs.some((r) => r.sourceSystem === `GOOGLE_SHEETS:${t.gid}`)).map((t) => t.tag))];
}

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

const MISSED: Record<string, string> = { NO_ANSWER: "no answer", BUSY: "line busy", VOICEMAIL: "voicemail, hung up", FAILED: "call did not go through", CANCELED: "call canceled" };

/** The owner's driver card for one finished call: a full card when the driver talked, a one-line note otherwise, or null for demo records. */
export async function buildCallReport(attemptId: string): Promise<string | null> {
  const a = await db.callAttempt.findUnique({ where: { id: attemptId }, include: { lead: { include: { screening: true, campaign: true } } } });
  if (!a || a.lead.isDemo) return null;
  const l = a.lead;
  const slot = (k: string) => l.screening.find((f) => f.key === k && f.reportedValue)?.reportedValue ?? "";
  const v = (s: string | null | undefined) => esc((s ?? "").trim());
  const team = /team/i.test(slot("driving_type"));
  const name = v([l.firstName, l.lastName].filter(Boolean).join(" "));
  const tags = await recruiterTags(l.id);
  const retryLine = l.attemptCount < l.campaign.maxAttempts ? `🔁 ${v(config.agentPersona.name)} will try again (attempt ${l.attemptCount} of ${l.campaign.maxAttempts})` : `⛔ No more AI attempts; call manually`;
  if (!a.startedAt || a.status === "VOICEMAIL") {
    // Nobody picked up: still tell the group the call was made, so a missing card is never a mystery.
    const why = MISSED[a.status] ?? a.status.toLowerCase().replace(/_/g, " ");
    return [...tags, `📵 ${v(config.agentPersona.name)} AI called ${name || "a driver"}: ${why}`, `☎️ ${v(l.phoneE164)}`, retryLine].join("\n");
  }
  const secs = a.startedAt && a.endedAt ? Math.round((a.endedAt.getTime() - a.startedAt.getTime()) / 1000) : null;
  const ended = endedByText(whoEnded(a), config.agentPersona.name);
  const endLine = ended ? `📴 ${v(ended)}${secs !== null ? ` (${secs} sec call)` : ""}` : null;
  if (!l.screening.some((f) => f.reportedValue)) {
    // Nothing was collected (driver hung up, short call): a one-line note instead of an empty card.
    return [
      ...tags,
      `📞 ${v(config.agentPersona.name)} AI called ${name || "a driver"}${secs !== null ? ` (${secs} sec)` : ""}: no answers collected`,
      `☎️ ${v(l.phoneE164)}`,
      ...(endLine ? [endLine] : []),
      ...lastDriverLines(a.transcript),
      retryLine,
    ].join("\n");
  }
  const fit = fitScore(answersOf(l.screening), fitRulesFrom((await getSettings()).fitRules));
  return [
    ...tags,
    `👔Recruiter: ${v(config.agentPersona.name)} AI`,
    `🥸Driver type: ${team ? "Team" : "Solo"}`,
    `🗒Driver name: ${name}`,
    `🌍State: ${v(l.state || slot("home_location"))}`,
    `🏠Home time: ${v(slot("home_time"))}`,
    `📈Experience: ${v(slot("experience_years"))}`,
    `💵Payment: asking: `,
    `🚛can drive: ${v(slot("weekly_miles"))}`,
    `🗣 English: ${v(slot("english_level"))}`,
    `✅ Ready date: ${v(slot("start_date"))}`,
    `☎️Phone number : ${v(l.phoneE164)}`,
    `⭐ Fit: ${v(fitText(fit))}`,
    ...(endLine ? [endLine] : []),
  ].join("\n");
}

export async function sendCallReport(attemptId: string) {
  if (!telegramConfigured()) return { sent: false, reason: "not configured" };
  const text = await buildCallReport(attemptId);
  if (!text) return { sent: false, reason: "nothing to report" };
  const a = await db.callAttempt.findUnique({ where: { id: attemptId }, include: { lead: true } });
  if (a?.recordingKey) {
    // The card goes as the caption of the call recording.
    const data = await getAdapters().storage.get(a.recordingKey);
    const form = new FormData();
    form.set("chat_id", config.telegram.chatId!);
    form.set("caption", text.slice(0, 1024));
    form.set("parse_mode", "HTML");
    const who = [a.lead.firstName, a.lead.lastName].filter(Boolean).join(" ") || "driver";
    form.set("audio", new Blob([new Uint8Array(data)], { type: recordingMime(a.recordingKey) }), `${who.replace(/[^A-Za-z0-9]+/g, "_")}_call.${a.recordingKey.split(".").pop()}`);
    await providerFetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendAudio`, { method: "POST", body: form, timeoutMs: 120_000 });
    return { sent: true, withRecording: true };
  }
  await sendTelegram(text);
  return { sent: true };
}

/** Tells the group a driver answered one of our texts (the missed-call text, usually). */
export async function sendSmsReplyToTelegram(leadId: string, text: string) {
  const l = await db.lead.findUnique({ where: { id: leadId } });
  if (!l || l.isDemo) return { sent: false };
  const name = esc([l.firstName, l.lastName].filter(Boolean).join(" ") || "A driver");
  await sendTelegram([...(await recruiterTags(l.id)), `💬 ${name} replied by text:`, `"${esc(text)}"`, `☎️ ${esc(l.phoneE164)}`].join("\n"));
  return { sent: true };
}

/** Tells the group a driver signed the record check authorization. */
export async function sendConsentToTelegram(consentId: string) {
  if (!telegramConfigured()) return { sent: false, reason: "not configured" };
  const c = await db.recordCheckConsent.findUnique({ where: { id: consentId }, include: { lead: true } });
  if (!c || c.lead.isDemo) return { sent: false, reason: "nothing to send" };
  const name = [c.lead.firstName, c.lead.lastName].filter(Boolean).join(" ");
  await sendTelegram([
    ...(await recruiterTags(c.leadId)),
    `✅ Record check consent: AGREED`,
    `🗒 ${esc(name)}`,
    `☎️ ${esc(c.lead.phoneE164)}`,
    `✍️ Signed as: ${esc(c.fullName)}`,
    `🕒 ${c.createdAt.toISOString().replace("T", " ").slice(0, 16)} UTC`,
  ].join("\n"));
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
  form.set("caption", [...(await recruiterTags(d.leadId)), `📎 CDL / medical card`, `🗒 ${name}`, `☎️ ${d.lead.phoneE164}`].join("\n"));
  form.set("document", new Blob([new Uint8Array(data)], { type: d.mimeType }), `${(name || "driver").replace(/[^A-Za-z0-9]+/g, "_")}.${d.storageKey.split(".").pop()}`);
  await providerFetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form, timeoutMs: 60000 });
  return { sent: true };
}
