import { db } from "./db";
import { getSettings } from "./settings";
import { evaluateContactGate } from "./contact-policy";
import { createUploadLink } from "./documents";
import { recordEvent } from "./activity";
import { advancePipeline, optOutLead } from "./leads";
import { getAdapters } from "../adapters/registry";
import { LiveContactBlockedError } from "../adapters/types";

const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|revoke|opt ?out)\s*$/i;

/** Send the secure CDL upload link by SMS. Idempotent per call attempt. */
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
    await db.contactPermission.create({ data: { leadId, scope: "SMS", source: `Verbal consent during AI call ${attemptId ?? ""}`.trim(), grantedAt: now, evidence: "Driver agreed to receive the CDL upload link by text (see call transcript).", isDemo: lead.isDemo } });
  }
  const link = await createUploadLink(leadId);
  const ttl = settings.uploadLinkTtlMinutes;
  const body = `${lead.org.name} recruiting team: can you send your CDL and medical card here please: ${link.url} . Link expires in ${ttl >= 60 ? `${Math.round(ttl / 60)} hr` : `${ttl} min`}. Reply STOP to opt out.`;
  const stored = body.replace(link.token, "[link-token]");
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
  await recordEvent({ leadId, actorType: "AI", type: "SMS_SENT", message: `Secure CDL upload link sent by text${getAdapters().sms.isMock ? " (MOCK, not delivered to a phone)" : ""}` });
  return { sent: true, messageId: msg.id, uploadUrl: link.url };
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
  }
  return { matched: true };
}
