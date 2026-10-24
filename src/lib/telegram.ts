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
import { leadSheetTab } from "./recruiter-tab";
import { log } from "./redact";
import type { CallNotes } from "./transcript-extract";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Up to two last things the driver said, for the short "nothing collected" note. */
function lastDriverLines(transcript: unknown): string[] {
  if (!Array.isArray(transcript)) return [];
  return (transcript as { speaker?: string; text?: string }[]).filter((t) => t.speaker === "driver" && t.text).slice(-2).map((t) => `🗣 Driver: "${esc(String(t.text).slice(0, 200))}"`);
}

/** "Molly = @molly_tbt" lines from Settings, by tab name in lower case ("" = not in the group). */
export function parseRecruiterTelegram(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split("\n")) {
    const [tab, user] = line.split("=").map((x) => x?.trim() ?? "");
    if (tab) m.set(tab.toLowerCase(), /^@?[A-Za-z0-9_]{3,64}$/.test(user) ? (user.startsWith("@") ? user : `@${user}`) : "");
  }
  return m;
}

/**
 * Who to tag on this lead's cards: the recruiter of the sheet tab the lead came from
 * (GOOGLE_SHEETS_EXTRA_TABS, a re-called "No answer" row, or the tab a recruiter moved
 * it to from the Pool). A recruiter no longer in the group is named instead.
 */
export async function recruiterTags(leadId: string): Promise<string[]> {
  const extra = config.googleSheets.extraTabs.filter((t) => t.tag);
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { sourceRecords: { select: { sourceSystem: true } } } });
  if (!lead) return [];
  const tags = extra.filter((t) => lead.sourceRecords.some((r) => r.sourceSystem === `GOOGLE_SHEETS:${t.gid}`)).map((t) => t.tag);
  const tab = await leadSheetTab(leadId);
  if (tab) {
    const who = parseRecruiterTelegram((await getSettings()).recruiterTelegram).get(tab.toLowerCase());
    if (who) tags.push(who);
    else if (!tags.length) tags.push(`👤 Before processed by ${esc(tab)}`);
  }
  return [...new Set(tags)];
}

export function telegramConfigured() {
  return !!(config.telegram.botToken && config.telegram.chatId);
}

/**
 * Posts to the group. With a lead, every message after the first about that driver is a
 * reply to the first one, so the group can open one driver's whole history (calls,
 * texts, CDL photos) from a single message.
 */
async function postToGroup(method: string, body: Record<string, string | Blob>, leadId?: string, timeoutMs?: number) {
  const token = config.telegram.botToken, configured = config.telegram.chatId;
  if (!token || !configured) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured");
  const lead = leadId ? await db.lead.findUnique({ where: { id: leadId }, select: { telegramThread: true } }) : null;
  const [threadChat, threadMsg] = (lead?.telegramThread ?? "").split(":");
  const post = async (chatId: string) => {
    const form = new FormData();
    for (const [k, v] of Object.entries({ chat_id: chatId, ...body })) form.set(k, v);
    if (threadMsg && threadChat === chatId) form.set("reply_parameters", JSON.stringify({ message_id: Number(threadMsg), allow_sending_without_reply: true }));
    return providerFetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", body: form, timeoutMs });
  };
  let chatId = movedChats.get(configured) ?? configured;
  let res;
  try {
    res = await post(chatId);
  } catch (e) {
    // The group became a supergroup (Telegram does this when some group settings change) and has a new id.
    const moved = (e as Error).message.match(/"migrate_to_chat_id":\s*(-?\d+)/)?.[1];
    if (!moved) throw e;
    movedChats.set(configured, moved);
    log.warn("Telegram group moved to a new chat id; set TELEGRAM_CHAT_ID to it", { from: configured, to: moved });
    chatId = moved;
    res = await post(chatId);
  }
  const sent = (await res.json().catch(() => null)) as { result?: { message_id?: number } } | null;
  // A lead's first message in this chat starts its thread (a thread from the old chat id cannot be replied to).
  if (leadId && !(threadMsg && threadChat === chatId) && sent?.result?.message_id) {
    await db.lead.updateMany({ where: { id: leadId, telegramThread: lead?.telegramThread ?? null }, data: { telegramThread: `${chatId}:${sent.result.message_id}` } });
  }
}

/** Old group chat id -> the supergroup id Telegram moved it to, until TELEGRAM_CHAT_ID is updated. */
const movedChats = new Map<string, string>();

export async function sendTelegram(text: string, leadId?: string) {
  await postToGroup("sendMessage", { text, parse_mode: "HTML", disable_web_page_preview: "true" }, leadId);
}

/**
 * The call's result, the reason a driver said no, the questions left unanswered, and the
 * short notes of the conversation, read from the transcript after the call.
 */
function notesLines(a: { outcome: string | null; summary: string | null; metrics: unknown }, talked: boolean): string[] {
  const n = ((a.metrics as { callNotes?: CallNotes } | null)?.callNotes ?? {}) as CallNotes;
  // Voicemail, call screening, a quick hang-up: nothing the driver said is worth a line.
  if (!talked && !["interested", "not_interested", "call_later"].includes(n.result ?? "") && !["INTERESTED", "NOT_INTERESTED", "CALLBACK"].includes(a.outcome ?? "")) return [];
  const no = a.outcome === "NOT_INTERESTED" || n.result === "not_interested";
  const out: string[] = [];
  if (no) out.push(`🔴 Not interested${n.reason ? `: ${esc(n.reason)}` : ""}`);
  else if (a.outcome === "INTERESTED" || n.result === "interested") out.push("🟢 Interested");
  else if (a.outcome === "CALLBACK" || n.result === "call_later") out.push("🕒 Asked to call later");
  else if (n.result === "unclear") out.push("⚪ Result unclear");
  if (!no && n.unanswered) out.push(`❓ Not answered: ${esc(n.unanswered)}`);
  if (a.summary) out.push(NOTES_MARK, esc(a.summary));
  return out;
}

const NOTES_MARK = "📝 Notes:";

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
  const retryLine = l.attemptCount >= l.campaign.maxAttempts ? `⛔ No more AI attempts; call manually`
    : l.nextContactAt ? `🔁 ${v(config.agentPersona.name)} will try again (attempt ${l.attemptCount} of ${l.campaign.maxAttempts})`
    : `⏹ No more AI calls${l.queueReason ? `: ${v(l.queueReason)}` : ""}`;
  if (!a.startedAt || a.status === "VOICEMAIL") {
    // Nobody picked up: still tell the group the call was made, so a missing card is never a mystery.
    const why = MISSED[a.status] ?? a.status.toLowerCase().replace(/_/g, " ");
    return [...tags, `📞 ${v(config.agentPersona.name)} AI called ${name || "a driver"}: ${why}`, `☎️ ${v(l.phoneE164)}`, retryLine].join("\n");
  }
  const secs = a.startedAt && a.endedAt ? Math.round((a.endedAt.getTime() - a.startedAt.getTime()) / 1000) : null;
  const ended = endedByText(whoEnded(a), config.agentPersona.name);
  const transferNote = Array.isArray(a.transcript) ? (a.transcript as { text?: string }[]).map((t) => /\[transfer(?::\s*([^\],]+))?/.exec(String(t.text ?? ""))).find(Boolean) : null;
  const transferred = !!transferNote;
  const transferTo = transferNote?.[1]?.trim();
  const endLine = transferred ? `🔀 ${v(config.agentPersona.name)} transferred the driver to ${transferTo && !/^(manager|office)$/i.test(transferTo) ? v(transferTo) : "the main line"}${secs !== null ? ` (${secs} sec call)` : ""}` : ended ? `📴 ${v(ended)}${secs !== null ? ` (${secs} sec call)` : ""}` : null;
  // The full card is for a call where the driver talked: answers saved in this call (an English
  // rating or a name check alone does not count) or a decision. A later voicemail or call
  // screening on a driver who talked before gets the short note, not their old card again.
  const talked = l.screening.some((f) => f.callAttemptId === a.id && f.reportedValue && !["english_level", "first_name"].includes(f.key))
    || ["INTERESTED", "NOT_INTERESTED", "CALLBACK", "HUMAN_REQUESTED"].includes(a.outcome ?? "");
  if (!talked) {
    return [
      ...tags,
      `📞 ${v(config.agentPersona.name)} AI called ${name || "a driver"}${secs !== null ? ` (${secs} sec)` : ""}: ${transferred ? "driver asked for a person" : "no answers collected"}`,
      `☎️ ${v(l.phoneE164)}`,
      ...(endLine ? [endLine] : []),
      ...lastDriverLines(a.transcript),
      ...notesLines(a, false),
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
    ...notesLines(a, true),
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
    const who = [a.lead.firstName, a.lead.lastName].filter(Boolean).join(" ") || "driver";
    const audio = new File([new Uint8Array(data)], `${who.replace(/[^A-Za-z0-9]+/g, "_")}_call.${a.recordingKey.split(".").pop()}`, { type: recordingMime(a.recordingKey) });
    // A caption holds 1024 characters: a long card's notes follow as a reply.
    const cut = text.length > 1024 ? text.indexOf(NOTES_MARK) : -1;
    const caption = cut > 0 ? text.slice(0, cut).trimEnd() : text.slice(0, 1024);
    await postToGroup("sendAudio", { caption, parse_mode: "HTML", audio }, a.leadId, 120_000);
    if (cut > 0) await sendTelegram(text.slice(cut).slice(0, 4000), a.leadId);
    return { sent: true, withRecording: true };
  }
  await sendTelegram(text, a?.leadId);
  return { sent: true };
}

/** Tells the group a driver answered one of our texts (the missed-call text, usually). */
export async function sendSmsReplyToTelegram(leadId: string, text: string) {
  const l = await db.lead.findUnique({ where: { id: leadId } });
  if (!l || l.isDemo) return { sent: false };
  const name = esc([l.firstName, l.lastName].filter(Boolean).join(" ") || "A driver");
  await sendTelegram([...(await recruiterTags(l.id)), `💬 ${name} replied by text:`, `"${esc(text)}"`, `☎️ ${esc(l.phoneE164)}`].join("\n"), l.id);
  return { sent: true };
}

/** Celebrates a hire Crystal's lead turned into (set by a recruiter on the lead page). */
export async function sendHiredToTelegram(leadId: string, by: string) {
  const l = await db.lead.findUnique({ where: { id: leadId } });
  if (!l || l.isDemo) return { sent: false };
  const name = esc([l.firstName, l.lastName].filter(Boolean).join(" ") || "A driver");
  await sendTelegram([...(await recruiterTags(l.id)), `🎉 ${name} was HIRED (marked by ${esc(by)})`, `Lead from ${config.agentPersona.name} AI, came in ${l.createdAt.toISOString().slice(0, 10)}`].join("\n"), l.id);
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
  ].join("\n"), c.leadId);
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
  const caption = [...(await recruiterTags(d.leadId)), `📎 CDL / medical card`, `🗒 ${name}`, `☎️ ${d.lead.phoneE164}`].join("\n");
  const document = new File([new Uint8Array(data)], `${(name || "driver").replace(/[^A-Za-z0-9]+/g, "_")}.${d.storageKey.split(".").pop()}`, { type: d.mimeType });
  await postToGroup("sendDocument", { caption, document }, d.leadId, 60_000);
  return { sent: true };
}
