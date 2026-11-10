// Drivers calling Crystal's number. Telnyx asks the dynamic-variables webhook for
// the call's {{variables}} when a call starts; for an inbound call we find (or
// create) the lead by the caller's number, open a call attempt for it and answer
// with the same variables an outbound call gets, plus call_direction "inbound".
import type { Job } from "@prisma/client";
import { db } from "./db";
import { config } from "./config";
import { normalizePhone } from "./phone";
import { recordEvent } from "./activity";
import { enqueue } from "./jobs/queue";
import { ingestLead } from "./leads";
import { getActiveOfferVersion } from "./knowledge";
import { getSettings } from "./settings";
import { companyName } from "./company";
import { callVariables, ingestVoiceEvent, STATUS_RANK, timeGreeting } from "./calls";

const LIVE = ["SCHEDULED", "DIALING", "RINGING", "IN_PROGRESS"] as const;

type InitPayload = { telnyx_conversation_channel?: string; telnyx_end_user_target?: string; telnyx_agent_target?: string; call_control_id?: string };

/** Variables for a call that is starting; {} when it is one of our outbound calls (they carry their own). */
export async function inboundInit(body: unknown, now = new Date()): Promise<{ dynamic_variables?: Record<string, string> }> {
  const data = (body as { data?: { payload?: InitPayload } })?.data;
  const p: InitPayload = data?.payload ?? (body as InitPayload) ?? {};
  if (p.telnyx_conversation_channel && p.telnyx_conversation_channel !== "phone_call") return {};
  const caller = normalizePhone(p.telnyx_end_user_target);
  if (!caller || !p.call_control_id) return {};

  // Our own outbound call to this number: the API already set every variable.
  const outbound = await db.callAttempt.findFirst({
    where: { direction: "OUTBOUND", status: { in: [...LIVE] }, createdAt: { gte: new Date(now.getTime() - 5 * 60_000) }, lead: { phoneE164: caller } },
  });
  if (outbound) return {};

  const existing = await db.callAttempt.findUnique({ where: { idempotencyKey: `inbound:${p.call_control_id}` } });
  let lead = await db.lead.findFirst({ where: { phoneE164: caller, isDemo: false }, orderBy: { createdAt: "desc" }, include: { permissions: true, campaign: true } });
  const known = !!lead;
  if (!lead) {
    const org = await db.organization.findFirst({ where: { isMain: true }, orderBy: { createdAt: "asc" } });
    const campaign = org && (await db.campaign.findFirst({ where: { orgId: org.id, isDemo: false }, orderBy: { createdAt: "asc" } }));
    if (!org || !campaign) return { dynamic_variables: genericVariables(now, await companyName(org ?? { name: "our company", isMain: true })) };
    const r = await ingestLead({ sourceSystem: "INBOUND_CALL", sourceRecordId: caller, phone: caller, raw: { source: "Called Crystal's number" } }, { orgId: org.id, campaignId: campaign.id, isDemo: false, scheduleOutreach: false });
    if (!("leadId" in r) || !r.leadId) return { dynamic_variables: genericVariables(now, await companyName(org)) };
    lead = await db.lead.findUnique({ where: { id: r.leadId }, include: { permissions: true, campaign: true } });
    if (!lead) return {};
  }

  const offer = await getActiveOfferVersion(lead.campaign.offerId);
  const settings = await getSettings();
  const attempt = existing ?? (await db.callAttempt.create({
    data: {
      leadId: lead.id, isDemo: false, provider: "telnyx", direction: "INBOUND", providerCallId: p.call_control_id, idempotencyKey: `inbound:${p.call_control_id}`,
      status: "IN_PROGRESS", statusRank: STATUS_RANK.IN_PROGRESS, offerVersionId: offer?.id ?? null, recordingNoticeGiven: settings.recordingEnabled, startedAt: now,
    },
  }));
  if (!existing) {
    await db.lead.updateMany({ where: { id: lead.id, activeAttemptId: null }, data: { activeAttemptId: attempt.id } });
    await recordEvent({ leadId: lead.id, actorType: "DRIVER", type: "INBOUND_CALL", message: `${known ? "Driver" : "New caller"} called Crystal's number`, data: { attemptId: attempt.id } });
    // Safety net when no end-of-call callback arrives: close the attempt so the card and transcript still come.
    await enqueue("call.inbound-close", { attemptId: attempt.id }, { runAt: new Date(now.getTime() + 20 * 60_000), idempotencyKey: `inbound-close:${attempt.id}` });
  }

  const vars = await callVariables(lead, attempt.id, offer?.id ?? "", now);
  const company = vars.company_name;
  const tg = timeGreeting(lead.timezone, now);
  return {
    dynamic_variables: {
      ...vars,
      call_direction: "inbound",
      applied_when: known ? vars.applied_when : "",
      opening_line: lead.firstName ? `${tg}, thanks for calling ${company}! This is ${config.agentPersona.name}. Is this ${lead.firstName}?` : `${tg}, thanks for calling ${company}! This is ${config.agentPersona.name}. How can I help you?`,
    },
  };
}

function genericVariables(now: Date, company: string): Record<string, string> {
  return { call_direction: "inbound", company_name: company, driver_first_name: "", applied_when: "", opening_line: `${timeGreeting(null, now)}, thanks for calling ${company}! This is ${config.agentPersona.name}. How can I help you?` };
}

/** A TeXML status callback without our attempt id: find the inbound attempt by its call id or the caller's number. */
export async function inboundAttemptId(body: Record<string, unknown>, now = new Date()): Promise<string | undefined> {
  const sid = String(body.CallSid ?? body.call_sid ?? "");
  if (sid) {
    const a = await db.callAttempt.findUnique({ where: { providerCallId: sid } });
    if (a) return a.id;
  }
  const dir = String(body.Direction ?? body.direction ?? "").toLowerCase();
  if (dir && !dir.startsWith("inbound")) return undefined;
  const from = normalizePhone(String(body.From ?? body.from ?? ""));
  if (!from) return undefined;
  const a = await db.callAttempt.findFirst({
    where: { direction: "INBOUND", status: { in: [...LIVE] }, createdAt: { gte: new Date(now.getTime() - 30 * 60_000) }, lead: { phoneE164: from } },
    orderBy: { createdAt: "desc" },
  });
  return a?.id;
}

export async function inboundCloseJob(job: Job) {
  const { attemptId } = job.payload as { attemptId: string };
  const a = await db.callAttempt.findUnique({ where: { id: attemptId } });
  if (!a || !(LIVE as readonly string[]).includes(a.status)) return;
  await ingestVoiceEvent({ provider: "telnyx", eventId: `inbound-close:${attemptId}`, type: "call_ended", attemptId, status: "COMPLETED", metrics: { reason: "closed after 20 minutes without an end callback" } });
}
