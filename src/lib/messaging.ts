import { db } from "./db";
import { getSettings } from "./settings";
import { evaluateContactGate } from "./contact-policy";
import { createUploadLink, detectMime, saveDriverDocument } from "./documents";
import { config } from "./config";
import { normalizePhone } from "./phone";
import { downloadRcAttachment, listInboundRcMessages } from "../adapters/live/ringcentral";
import { recordEvent } from "./activity";
import { enqueue } from "./jobs/queue";
import { advancePipeline, optOutLead } from "./leads";
import { getAdapters } from "../adapters/registry";
import { LiveContactBlockedError } from "../adapters/types";
import { telegramConfigured } from "./telegram";

const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|revoke|opt ?out)\s*$/i;

/**
 * Text the driver asking for their CDL and medical card. By default they just
 * reply with photos (the owner found a link looks odd); CDL_SMS_LINK=1 sends
 * the secure upload link instead. Idempotent per call attempt.
 */
export async function sendCdlLink(leadId: string, attemptId: string | null, opts: { verbalConsent: boolean; now?: Date }) {
  const idem = `cdl-link:${attemptId ?? leadId + ":" + new Date().toISOString().slice(0, 13)}`;
  const prior = await db.message.findUnique({ where: { idempotencyKey: idem } });
  if (prior) return { sent: false, reason: "already sent", messageId: prior.id };

  const settings = await getSettings();
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, include: { permissions: true, campaign: true, org: true } });
  const now = opts.now ?? new Date();
  const gate = await evaluateContactGate({ lead, settings, channel: "SMS", now, verbalSmsConsent: opts.verbalConsent });
  if (!gate.ok) {
    await recordEvent({ leadId, actorType: "SYSTEM", type: "SMS_BLOCKED", message: `CDL link not sent: ${gate.message}` });
    await db.task.upsert({
      where: { dedupeKey: `cdl-manual:${leadId}` },
      create: { leadId, type: "CALLBACK", assignedToId: lead.assignedToId, title: "Send CDL request manually (automatic text was blocked)", notes: gate.message, dedupeKey: `cdl-manual:${leadId}` },
      update: {},
    });
    return { sent: false, reason: gate.message };
  }
  if (opts.verbalConsent && !lead.permissions.some((p) => p.scope === "SMS" && !p.revokedAt)) {
    await db.contactPermission.create({ data: { leadId, scope: "SMS", source: `Verbal consent during AI call ${attemptId ?? ""}`.trim(), grantedAt: now, evidence: "Driver agreed to receive a text for their CDL and medical card (see call transcript).", isDemo: lead.isDemo } });
  }
  const useLink = process.env.CDL_SMS_LINK === "1";
  const link = useLink ? await createUploadLink(leadId) : null;
  const ttl = settings.uploadLinkTtlMinutes;
  const hi = lead.firstName ? `Hi ${lead.firstName}, it's ${config.agentPersona.name}. ` : "";
  const body = link
    ? `${lead.org.name} recruiting team: can you send your CDL and medical card here please: ${link.url} . Link expires in ${ttl >= 60 ? `${Math.round(ttl / 60)} hr` : `${ttl} min`}. Reply STOP to opt out.`
    : `${lead.org.name} recruiting team: ${hi}Can you send a photo of your CDL and medical card here please? Just reply to this text. Reply STOP to opt out.`;
  const stored = link ? body.replace(link.token, "[link-token]") : body;
  const msg = await db.message.create({ data: { leadId, isDemo: lead.isDemo, direction: "OUTBOUND", purpose: "CDL_LINK", body: stored, provider: getAdapters().sms.key, idempotencyKey: idem, status: "SENDING" } });
  try {
    const r = await getAdapters().sms.send(lead.phoneE164, body, idem);
    await db.message.update({ where: { id: msg.id }, data: { status: "SENT", providerMessageId: r.providerMessageId } });
  } catch (e) {
    await db.message.update({ where: { id: msg.id }, data: { status: e instanceof LiveContactBlockedError ? "BLOCKED" : "FAILED" } });
    await recordEvent({ leadId, actorType: "SYSTEM", type: "SMS_FAILED", message: `CDL link SMS failed: ${(e as Error).message}` });
    return { sent: false, reason: (e as Error).message };
  }
  await db.lead.update({ where: { id: leadId }, data: { documentStatus: "REQUESTED" } });
  await advancePipeline(leadId, "DOCS_REQUESTED");
  await recordEvent({ leadId, actorType: "AI", type: "SMS_SENT", message: `${link ? "Secure CDL upload link" : "CDL and medical card request"} sent by text${getAdapters().sms.isMock ? " (MOCK, not delivered to a phone)" : ""}` });
  return { sent: true, messageId: msg.id, uploadUrl: link?.url };
}

/**
 * One text after an unanswered AI call, asking when to call back. Sent at most
 * once per lead, only where an automated text is allowed right now.
 */
export async function sendMissedCallText(leadId: string, attemptId: string, now = new Date()) {
  const settings = await getSettings();
  if (!settings.missedCallSms) return { sent: false, reason: "off" };
  const idem = `missed-call:${leadId}`;
  if (await db.message.findUnique({ where: { idempotencyKey: idem } })) return { sent: false, reason: "already sent" };
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, include: { permissions: true, campaign: true, org: true } });
  if (lead.optedOutAt || ["OPTED_OUT", "CLOSED"].includes(lead.pipelineStatus)) return { sent: false, reason: "lead closed" };
  const gate = await evaluateContactGate({ lead, settings, channel: "SMS", now, verbalSmsConsent: false });
  if (!gate.ok) {
    await recordEvent({ leadId, actorType: "SYSTEM", type: "SMS_BLOCKED", message: `Missed-call text not sent: ${gate.message}` });
    return { sent: false, reason: gate.message };
  }
  const body = settings.missedCallSmsText
    .replace(/\{company\}/g, lead.org.name)
    .replace(/\{persona\}/g, config.agentPersona.name)
    .replace(/Hi \{first\}/g, lead.firstName ? `Hi ${lead.firstName}` : "Hi")
    .replace(/\{first\}/g, lead.firstName ?? "")
    .slice(0, 480);
  const msg = await db.message.create({ data: { leadId, isDemo: lead.isDemo, direction: "OUTBOUND", purpose: "MISSED_CALL", body, provider: getAdapters().sms.key, idempotencyKey: idem, status: "SENDING" } });
  try {
    const r = await getAdapters().sms.send(lead.phoneE164, body, idem);
    await db.message.update({ where: { id: msg.id }, data: { status: "SENT", providerMessageId: r.providerMessageId } });
  } catch (e) {
    await db.message.update({ where: { id: msg.id }, data: { status: e instanceof LiveContactBlockedError ? "BLOCKED" : "FAILED" } });
    await recordEvent({ leadId, actorType: "SYSTEM", type: "SMS_FAILED", message: `Missed-call text failed: ${(e as Error).message}` });
    return { sent: false, reason: (e as Error).message };
  }
  await recordEvent({ leadId, actorType: "AI", type: "SMS_SENT", message: `Missed-call text sent${getAdapters().sms.isMock ? " (MOCK, not delivered to a phone)" : ""}`, data: { attemptId } });
  return { sent: true, messageId: msg.id };
}

/** Inbound SMS from a provider webhook. Message text is untrusted data. */
export async function handleInboundSms(fromE164: string, body: string, providerMessageId: string, provider: string) {
  const exists = await db.message.findUnique({ where: { providerMessageId } });
  if (exists) return { duplicate: true };
  const lead = await db.lead.findFirst({ where: { phoneE164: fromE164 }, orderBy: { createdAt: "desc" } });
  if (STOP_WORDS.test(body)) {
    await db.suppression.upsert({ where: { phoneE164: fromE164 }, create: { phoneE164: fromE164, reason: "OPT_OUT", source: `SMS STOP via ${provider}` }, update: {} });
    if (lead) await optOutLead(lead.id, "Driver replied STOP by text", { type: "DRIVER" });
  }
  if (!lead) return { matched: false };
  await db.message.create({ data: { leadId: lead.id, isDemo: lead.isDemo, direction: "INBOUND", purpose: "REPLY", body: body.slice(0, 1600), provider, providerMessageId, status: "RECEIVED" } });
  await recordEvent({ leadId: lead.id, actorType: "DRIVER", type: "SMS_RECEIVED", message: "Driver replied by text" });
  if (!STOP_WORDS.test(body)) {
    await db.task.create({ data: { leadId: lead.id, type: "CALLBACK", assignedToId: lead.assignedToId, title: "Driver replied by text", notes: body.slice(0, 500) } });
    if (telegramConfigured() && !lead.isDemo && body.trim() && body !== "(sent a photo)") {
      await enqueue("notify.telegram-sms-reply", { leadId: lead.id, text: body.slice(0, 500) }, { idempotencyKey: `telegram-sms:${providerMessageId}`, maxAttempts: 3 });
    }
  }
  return { matched: true };
}

/**
 * Reads texts drivers sent back to the RingCentral number (many reply with photos
 * of their CDL / medical card instead of using the link). Only messages from a
 * lead's phone are kept; photos and PDFs are saved as the lead's documents.
 */
export async function pollRingCentralInbound(now = new Date()) {
  const ours = normalizePhone(config.ringcentral.smsFromNumber);
  const msgs = await listInboundRcMessages(new Date(now.getTime() - 24 * 3600_000));
  let docs = 0;
  for (const m of msgs) {
    const from = normalizePhone(m.from);
    if (!from || (ours && !m.to.some((t) => normalizePhone(t) === ours))) continue;
    const lead = await db.lead.findFirst({ where: { phoneE164: from }, orderBy: { createdAt: "desc" } });
    if (!lead) continue;
    if (await db.message.findUnique({ where: { providerMessageId: `rc_${m.id}` } })) continue;
    const files: { data: Buffer; mime: string }[] = [];
    for (const a of m.attachments) {
      const data = await downloadRcAttachment(a.uri);
      const mime = detectMime(data);
      if (mime) files.push({ data, mime });
    }
    await handleInboundSms(from, m.text || (files.length ? "(sent a photo)" : ""), `rc_${m.id}`, "ringcentral");
    for (const f of files) { await saveDriverDocument(lead, f.data, f.mime, "text message"); docs++; }
  }
  return { checked: msgs.length, docs };
}

/** Called by the worker every minute in live mode when RingCentral is set up. */
export async function scheduleInboundSmsPoll(now = Date.now()) {
  const c = config.ringcentral;
  if (config.mode !== "live" || !c.clientId || !c.jwt || !c.smsFromNumber) return;
  await enqueue("sms.poll-inbound", {}, { idempotencyKey: `rc-inbound:${Math.floor(now / 60_000)}`, maxAttempts: 1 });
}
