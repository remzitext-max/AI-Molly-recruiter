// Call orchestration: gating, locking, provider calls, event ingestion,
// real-time agent actions, transfers and post-call workflow.
import type { CallOutcome, CallStatus, Job, Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "./db";
import { getSettings } from "./settings";
import { evaluateContactGate } from "./contact-policy";
import { recordEvent } from "./activity";
import { advancePipeline, optOutLead, scheduleLeadCall } from "./leads";
import { createHandoff, evaluateHandoffReadiness } from "./handoff";
import { sendCdlLink } from "./messaging";
import { telegramConfigured } from "./telegram";
import { enqueue } from "./jobs/queue";
import { getActiveOfferVersion } from "./knowledge";
import { redactText } from "./redact";
import { formatLocal } from "./timezone";
import { getAdapters } from "../adapters/registry";
import { config } from "./config";
import { LiveContactBlockedError, UncertainOutcomeError } from "../adapters/types";
import { ALLOWED_ACTIONS, RecruitingBrain, type AgentAction, type DriverInput } from "./conversation/brain";
import { personaByKey } from "./conversation/personas";
import { mockCalls } from "../adapters/mock";
import { SHEETS_SOURCE } from "./import";
import { writeBackLeadStatus } from "./sheets-sync";

export const STATUS_RANK: Record<CallStatus, number> = {
  SCHEDULED: 0, UNKNOWN: 0, DIALING: 1, RINGING: 2, IN_PROGRESS: 3,
  COMPLETED: 10, NO_ANSWER: 10, BUSY: 10, VOICEMAIL: 10, FAILED: 10, CANCELED: 10,
};
const TERMINAL = 10;

// ---------------------------------------------------------------------------
// 1. Attempt a call (job handler for "lead.attempt-call")
// ---------------------------------------------------------------------------
export async function attemptCallJob(job: Job) {
  const { leadId } = job.payload as { leadId: string; personaKey?: string | null };
  let personaKey = (job.payload as { personaKey?: string | null }).personaKey ?? null;
  if (!personaKey && config.mode === "demo") {
    // Demo retries/callbacks keep the synthetic driver's scripted behaviour.
    personaKey = (await db.callAttempt.findFirst({ where: { leadId, personaKey: { not: null } }, orderBy: { createdAt: "desc" } }))?.personaKey ?? null;
  }
  const now = new Date();
  const settings = await getSettings();
  const lead = await db.lead.findUnique({ where: { id: leadId }, include: { permissions: true, campaign: true } });
  if (!lead) return;

  const gate = await evaluateContactGate({ lead, settings, channel: "CALL", now });
  if (!gate.ok) {
    await db.lead.update({ where: { id: leadId }, data: { queueReason: gate.message, nextContactAt: gate.retryAt ?? null } });
    if (gate.retryAt) {
      // Still queued: e.g. outside permitted hours, or paused.
      return { rescheduleAt: gate.retryAt, reason: gate.code };
    }
    if (gate.pipeline) await advancePipeline(leadId, gate.pipeline, db, { force: gate.pipeline === "OPTED_OUT" || lead.pipelineStatus === "QUEUED" || lead.pipelineStatus === "NEW" });
    if (gate.code === "NO_PERMISSION") await upsertTask(leadId, "RECORD_PERMISSION", "Record contact permission before AI calling", lead.assignedToId, gate.message);
    if (gate.code === "NO_TIMEZONE") await upsertTask(leadId, "RESOLVE_TIMEZONE", "Confirm driver timezone (state/ZIP unclear)", lead.assignedToId, gate.message);
    if (gate.code === "MAX_ATTEMPTS") await upsertTask(leadId, "CALLBACK", "AI could not reach driver: try manually", lead.assignedToId, gate.message);
    await recordEvent({ leadId, actorType: "SYSTEM", type: "CALL_BLOCKED", message: `Call not placed: ${gate.message}` });
    return;
  }

  // Never retry while a previous attempt's real outcome is unknown.
  const uncertain = await db.callAttempt.findFirst({ where: { leadId, status: "UNKNOWN" } });
  if (uncertain) {
    await enqueue("call.reconcile", { attemptId: uncertain.id }, { idempotencyKey: `reconcile:${uncertain.id}:${Math.floor(Date.now() / 300000)}` });
    return { rescheduleAt: new Date(Date.now() + 5 * 60_000), reason: "AWAITING_RECONCILE" };
  }

  const offer = await getActiveOfferVersion(lead.campaign.offerId);
  if (config.mode === "live" && (!offer || offer.synthetic)) {
    const msg = offer ? "Campaign offer is synthetic demo data; publish real approved facts first" : "Campaign has no published offer";
    await db.lead.update({ where: { id: leadId }, data: { queueReason: msg } });
    await recordEvent({ leadId, actorType: "SYSTEM", type: "CALL_BLOCKED", message: `Call not placed: ${msg}` });
    return { rescheduleAt: new Date(Date.now() + 60 * 60_000), reason: "NO_REAL_OFFER" };
  }
  const provider = getAdapters().voice;

  // The phone line has a fixed number of channels: queued leads wait their turn
  // instead of all dialing at once (extra calls fail at the carrier).
  if (!provider.isMock && (await realCallsInProgress(now)) >= config.maxConcurrentCalls) {
    await db.lead.update({ where: { id: leadId }, data: { queueReason: "Waiting for a free line (another call in progress)" } });
    return { rescheduleAt: new Date(Date.now() + 45_000), reason: "LINE_BUSY" };
  }

  // Acquire the per-lead call lock atomically. activeAttemptId is UNIQUE and is
  // only set when currently NULL, so two workers can never dial the same lead.
  const attempt = await db.$transaction(async (tx) => {
    const a = await tx.callAttempt.create({
      data: { leadId, isDemo: lead.isDemo, provider: provider.key, idempotencyKey: `job:${job.id}`, status: "SCHEDULED", offerVersionId: offer?.id ?? null, personaKey: personaKey ?? null, recordingNoticeGiven: settings.recordingEnabled },
    }).catch((e: { code?: string }) => { if (e.code === "P2002") return null; throw e; });
    if (!a) return null;
    const locked = await tx.lead.updateMany({ where: { id: leadId, activeAttemptId: null }, data: { activeAttemptId: a.id, attemptCount: { increment: 1 }, queueReason: null, nextContactAt: null } });
    if (!locked.count) throw new Error("LEAD_BUSY");
    return a;
  }).catch((e: Error) => { if (e.message === "LEAD_BUSY") return "BUSY" as const; throw e; });

  if (attempt === "BUSY") return { rescheduleAt: new Date(Date.now() + 2 * 60_000), reason: "CALL_ALREADY_ACTIVE" };
  if (!attempt) return; // this job already created its attempt (duplicate delivery)

  await recordEvent({ leadId, actorType: "SYSTEM", type: "CALL_STARTING", message: `Outbound AI call #${lead.attemptCount + 1} starting${provider.isMock ? " (SIMULATED)" : ""}`, data: { attemptId: attempt.id } });
  try {
    const { providerCallId } = await provider.startOutboundCall({
      attemptId: attempt.id, leadId, toE164: lead.phoneE164, isDemoRecord: lead.isDemo, personaKey,
      dynamicVariables: await callVariables(lead, attempt.id, offer?.id ?? ""),
    });
    await db.callAttempt.update({ where: { id: attempt.id }, data: { providerCallId, status: "DIALING", statusRank: STATUS_RANK.DIALING } });
  } catch (e) {
    if (e instanceof UncertainOutcomeError) {
      await db.callAttempt.update({ where: { id: attempt.id }, data: { status: "UNKNOWN", errorMessage: e.message } });
      await releaseLock(leadId, attempt.id);
      await enqueue("call.reconcile", { attemptId: attempt.id }, { runAt: new Date(Date.now() + 60_000), idempotencyKey: `reconcile:${attempt.id}:0` });
      await recordEvent({ leadId, actorType: "SYSTEM", type: "CALL_UNCERTAIN", message: "Provider outcome unknown; will reconcile before any retry" });
      return;
    }
    const blocked = e instanceof LiveContactBlockedError;
    await db.callAttempt.update({ where: { id: attempt.id }, data: { status: blocked ? "CANCELED" : "FAILED", statusRank: TERMINAL, outcome: blocked ? null : "TECHNICAL_FAILURE", errorMessage: (e as Error).message, endedAt: new Date() } });
    if (blocked) await db.lead.update({ where: { id: leadId }, data: { attemptCount: { decrement: 1 }, queueReason: (e as Error).message } });
    await releaseLock(leadId, attempt.id);
    await recordEvent({ leadId, actorType: "SYSTEM", type: blocked ? "CALL_BLOCKED" : "CALL_FAILED", message: `${blocked ? "Real contact blocked" : "Call failed to start"}: ${(e as Error).message}` });
    if (!blocked) throw e; // retried by the queue with backoff
  }
}

/** Real (non-demo) calls that are dialing or talking now. Attempts older than 20 min are ignored as stuck. */
export async function realCallsInProgress(now = new Date()) {
  return db.callAttempt.count({ where: { isDemo: false, status: { in: ["SCHEDULED", "DIALING", "RINGING", "IN_PROGRESS"] }, createdAt: { gte: new Date(now.getTime() - 20 * 60_000) } } });
}

async function releaseLock(leadId: string, attemptId: string) {
  await db.lead.updateMany({ where: { id: leadId, activeAttemptId: attemptId }, data: { activeAttemptId: null } });
}

async function upsertTask(leadId: string, type: Prisma.TaskCreateInput["type"], title: string, assignedToId: string | null, notes?: string, dueAt?: Date, dedupe?: string) {
  const dedupeKey = dedupe ?? `${type}:${leadId}`;
  return db.task.upsert({
    where: { dedupeKey },
    create: { leadId, type, title, assignedToId, notes, dueAt, dedupeKey },
    update: { status: "OPEN", notes, dueAt },
  });
}

// ---------------------------------------------------------------------------
// 2. Provider events (webhooks or simulator). Idempotent and order-tolerant.
// ---------------------------------------------------------------------------
export interface VoiceEvent {
  provider: string;
  eventId: string;
  type: "call_started" | "call_ringing" | "call_answered" | "call_ended" | "transfer_started" | "transfer_succeeded" | "transfer_failed";
  providerCallId?: string;
  attemptId?: string;
  status?: CallStatus;
  outcome?: CallOutcome;
  transcript?: { speaker: string; text: string; at?: string; latencyMs?: number }[];
  summary?: string;
  metrics?: Record<string, unknown>;
  occurredAt?: string;
}

export async function ingestVoiceEvent(ev: VoiceEvent): Promise<{ duplicate: boolean; applied: boolean }> {
  try {
    await db.webhookEvent.create({ data: { provider: ev.provider, eventId: ev.eventId } });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return { duplicate: true, applied: false };
    throw e;
  }
  try {
    const applied = await applyVoiceEvent(ev);
    await db.webhookEvent.update({ where: { provider_eventId: { provider: ev.provider, eventId: ev.eventId } }, data: { processedAt: new Date() } });
    return { duplicate: false, applied };
  } catch (e) {
    // Let the provider retry: forget the dedupe marker on failure.
    await db.webhookEvent.delete({ where: { provider_eventId: { provider: ev.provider, eventId: ev.eventId } } }).catch(() => {});
    throw e;
  }
}

async function findAttempt(ev: VoiceEvent) {
  if (ev.providerCallId) {
    const a = await db.callAttempt.findUnique({ where: { providerCallId: ev.providerCallId } });
    if (a) return a;
  }
  if (ev.attemptId) return db.callAttempt.findUnique({ where: { id: ev.attemptId } });
  return null;
}

async function applyVoiceEvent(ev: VoiceEvent): Promise<boolean> {
  const attempt = await findAttempt(ev);
  if (!attempt) throw new Error(`Unknown call for event ${ev.eventId}`);
  if (ev.providerCallId && !attempt.providerCallId) await db.callAttempt.update({ where: { id: attempt.id }, data: { providerCallId: ev.providerCallId } });

  if (ev.type.startsWith("transfer_")) return applyTransferEvent(attempt.id, attempt.leadId, ev);

  const status: CallStatus = ev.status ?? (ev.type === "call_started" ? "DIALING" : ev.type === "call_ringing" ? "RINGING" : ev.type === "call_answered" ? "IN_PROGRESS" : "COMPLETED");
  const rank = STATUS_RANK[status];
  const at = ev.occurredAt ? new Date(ev.occurredAt) : new Date();

  if (rank < TERMINAL) {
    // Out-of-order safe: only move forward, never regress a finished call.
    const r = await db.callAttempt.updateMany({ where: { id: attempt.id, statusRank: { lt: rank } }, data: { status, statusRank: rank, lastEventAt: at, startedAt: status === "IN_PROGRESS" ? at : undefined } });
    return r.count > 0;
  }

  // Terminal: first terminal event wins and triggers the post-call workflow once.
  const r = await db.callAttempt.updateMany({
    where: { id: attempt.id, statusRank: { lt: TERMINAL } },
    data: {
      status, statusRank: TERMINAL, endedAt: at, lastEventAt: at,
      outcome: ev.outcome ?? attempt.outcome ?? defaultOutcome(status),
      summary: ev.summary ? redactText(ev.summary) : undefined,
      transcript: ev.transcript ? (ev.transcript.map((t) => ({ ...t, text: redactText(t.text) })) as Prisma.InputJsonValue) : undefined,
      metrics: ev.metrics as Prisma.InputJsonValue | undefined,
    },
  });
  if (!r.count) {
    // Late duplicate data (e.g. call_analyzed after call_ended): fill gaps only.
    if (ev.transcript || ev.summary || ev.metrics) {
      await db.callAttempt.update({ where: { id: attempt.id }, data: {
        // Keep both callbacks' fields (e.g. the conversation's end reason after the TeXML status).
        metrics: ev.metrics ? ({ ...(attempt.metrics as Record<string, unknown> | null), ...Object.fromEntries(Object.entries(ev.metrics).filter(([, v]) => v !== null && v !== undefined)) } as Prisma.InputJsonValue) : undefined,
        transcript: attempt.transcript ? undefined : (ev.transcript?.map((t) => ({ ...t, text: redactText(t.text) })) as Prisma.InputJsonValue | undefined),
        summary: attempt.summary ? undefined : ev.summary ? redactText(ev.summary) : undefined,
      } });
    }
    return false;
  }
  await releaseLock(attempt.leadId, attempt.id);
  await postCallWorkflow(attempt.id);
  return true;
}

function defaultOutcome(s: CallStatus): CallOutcome | null {
  if (s === "NO_ANSWER" || s === "BUSY") return "NO_CONTACT";
  if (s === "VOICEMAIL") return "VOICEMAIL_LEFT";
  if (s === "FAILED") return "TECHNICAL_FAILURE";
  if (s === "COMPLETED") return "INCOMPLETE";
  return null;
}

// ---------------------------------------------------------------------------
// 3. Post-call workflow
// ---------------------------------------------------------------------------
async function postCallWorkflow(attemptId: string) {
  const a = await db.callAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { lead: { include: { campaign: true } } } });
  const lead = a.lead;
  const outcome = a.outcome;
  await recordEvent({ leadId: lead.id, actorType: "SYSTEM", type: "CALL_ENDED", message: `Call ended: ${a.status.toLowerCase()}${outcome ? `, outcome ${outcome.toLowerCase().replace(/_/g, " ")}` : ""}${a.isDemo ? " (simulated)" : ""}`, data: { attemptId } });

  switch (outcome) {
    case "INTERESTED":
      await advancePipeline(lead.id, "INTERESTED");
      await enqueue("handoff.evaluate", { leadId: lead.id }, { idempotencyKey: `handoff-eval:call:${attemptId}` });
      break;
    case "NOT_INTERESTED":
      await advancePipeline(lead.id, "NOT_INTERESTED");
      break;
    case "CALLBACK":
    case "HUMAN_REQUESTED":
    case "OPT_OUT":
    case "WRONG_NUMBER":
      break; // handled in real time by agent actions
    case "TECHNICAL_FAILURE":
      await createHandoff(lead.id, "TECHNICAL", { callAttemptId: attemptId, note: a.errorMessage ?? "Call failed" });
      await maybeRetry(lead.id, lead.campaign.retryDelayMinutes, lead.campaign.maxAttempts, "Retry after technical failure");
      break;
    default:
      if (["NO_ANSWER", "BUSY", "VOICEMAIL"].includes(a.status) || outcome === "NO_CONTACT" || outcome === "VOICEMAIL_LEFT") {
        await enqueue("sms.missed-call", { leadId: lead.id, attemptId }, { idempotencyKey: `missed-call:${lead.id}`, maxAttempts: 2 });
      }
      // No contact / voicemail / incomplete: bounded retry, progress untouched.
      // First call rang out: ring again in a minute; a second call from the same number is picked up far more often.
      if (a.status === "NO_ANSWER" && lead.attemptCount === 1) await maybeRetry(lead.id, 1, lead.campaign.maxAttempts, "Double dial after no answer");
      else await maybeRetry(lead.id, lead.campaign.retryDelayMinutes, lead.campaign.maxAttempts, `Retry after ${(outcome ?? a.status).toLowerCase().replace(/_/g, " ")}`);
  }
  // Sync results back to the source system when a connector supports it.
  await enqueue("lead.sync-source", { leadId: lead.id, attemptId }, { idempotencyKey: `sync:${attemptId}` });
  // Telnyx does not always post the transcript; read it from the Conversations API.
  // That job also fills answers the agent missed, then releases the Telegram card.
  const fetchTranscript = a.provider === "telnyx" && !!a.startedAt && !Array.isArray(a.transcript) && !lead.isDemo;
  if (fetchTranscript) {
    await enqueue("call.fetch-transcript", { attemptId }, { runAt: new Date(Date.now() + 20_000), idempotencyKey: `transcript:${attemptId}`, maxAttempts: 4 });
    // The Telnyx assistant records every answered call itself; keep our own copy.
    await enqueue("call.fetch-recording", { attemptId }, { runAt: new Date(Date.now() + 60_000), idempotencyKey: `recording:${attemptId}`, maxAttempts: 5 });
  }
  // Driver card (or a "no answer" note) to the owner's Telegram; a short delay lets the late summary arrive first.
  if (telegramConfigured() && !lead.isDemo) {
    await enqueue("notify.telegram-call-report", { attemptId }, { runAt: new Date(Date.now() + (fetchTranscript ? 6 * 60_000 : 45_000)), idempotencyKey: `telegram:${attemptId}`, maxAttempts: 3 });
  }
}

async function maybeRetry(leadId: string, delayMin: number, max: number, reason: string) {
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
  if (lead.optedOutAt) return;
  if (lead.attemptCount >= max) {
    await upsertTask(leadId, "CALLBACK", "AI could not reach driver: try manually", lead.assignedToId, `${lead.attemptCount} attempts made`);
    await db.lead.update({ where: { id: leadId }, data: { queueReason: "Max AI call attempts reached", nextContactAt: null } });
    return;
  }
  await scheduleLeadCall(leadId, { at: new Date(Date.now() + delayMin * 60_000), reason });
}

// ---------------------------------------------------------------------------
// 4. Real-time agent actions (provider tool calls / simulator)
// ---------------------------------------------------------------------------
const ActionSchema: z.ZodType<AgentAction> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("record_slot"), key: z.enum(["first_name", "home_location", "cdl_class", "endorsements", "restrictions", "experience_years", "equipment_experience", "driving_type", "route_preference", "home_time", "start_date", "recent_miles", "weeks_out", "weekly_miles", "sap_history", "accidents_at_fault", "med_card_expiry", "english_level", "offer_interest", "concerns"]), value: z.string().max(500), raw: z.string().max(2000), status: z.enum(["CAPTURED", "CORRECTED", "UNCLEAR"]) }),
  z.object({ type: z.literal("unanswered_question"), question: z.string().max(1000), reason: z.string().max(300) }),
  z.object({ type: z.literal("offer_discussed"), factKeys: z.array(z.string().max(80)).max(20) }),
  z.object({ type: z.literal("opt_out"), raw: z.string().max(2000) }),
  z.object({ type: z.literal("wrong_number") }),
  z.object({ type: z.literal("request_transfer"), reason: z.enum(["HUMAN_REQUESTED", "UNKNOWN_QUESTION", "ELIGIBILITY_EXCEPTION", "TECHNICAL"]) }),
  z.object({ type: z.literal("flag_handoff"), reason: z.enum(["HUMAN_REQUESTED", "UNKNOWN_QUESTION", "ELIGIBILITY_EXCEPTION", "TECHNICAL"]), note: z.string().max(1000) }),
  z.object({ type: z.literal("schedule_callback"), at: z.string().datetime({ offset: true }).nullable(), raw: z.string().max(1000) }),
  z.object({ type: z.literal("send_cdl_link") }),
  z.object({ type: z.literal("sensitive_data_warning") }),
  z.object({ type: z.literal("injection_attempt"), raw: z.string().max(2000) }),
  z.object({ type: z.literal("set_outcome"), outcome: z.enum(["INTERESTED", "NOT_INTERESTED", "CALLBACK", "OPT_OUT", "HUMAN_REQUESTED", "VOICEMAIL_LEFT", "NO_CONTACT", "WRONG_NUMBER", "INCOMPLETE", "TECHNICAL_FAILURE"]) }),
]) as unknown as z.ZodType<AgentAction>;

export type ActionResult = { ok: boolean; detail?: string; transfer?: "pending" | "failed" };

/**
 * The ONLY way agent decisions change data. Anything not in the closed schema
 * is rejected, so transcript/message content cannot invoke arbitrary actions.
 */
export async function applyAgentAction(attemptId: string, input: unknown): Promise<ActionResult> {
  const parsed = ActionSchema.safeParse(input);
  if (!parsed.success || !ALLOWED_ACTIONS.has(parsed.data.type)) {
    const a0 = await db.callAttempt.findUnique({ where: { id: attemptId }, select: { leadId: true } });
    await recordEvent({ leadId: a0?.leadId, actorType: "SYSTEM", type: "ACTION_REJECTED", message: "Rejected invalid agent action", data: { input: JSON.stringify(input).slice(0, 500) } });
    return { ok: false, detail: "invalid action" };
  }
  const action = parsed.data;
  const attempt = await db.callAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { lead: true } });
  const lead = attempt.lead;

  switch (action.type) {
    case "record_slot": {
      await db.screeningField.upsert({
        where: { leadId_key: { leadId: lead.id, key: action.key } },
        create: { leadId: lead.id, key: action.key, reportedValue: redactText(action.value), rawUtterance: redactText(action.raw).slice(0, 500), status: action.status, callAttemptId: attemptId },
        update: { reportedValue: redactText(action.value), rawUtterance: redactText(action.raw).slice(0, 500), status: action.status, callAttemptId: attemptId },
      });
      if (action.key === "home_location") await maybeUpdateLocation(lead.id, action.value);
      if (action.status === "UNCLEAR") await upsertTask(lead.id, "REVIEW_UNCLEAR", `Unclear answer: ${action.key.replace(/_/g, " ")}`, lead.assignedToId, action.raw.slice(0, 300), undefined, `unclear:${lead.id}:${action.key}`);
      if (action.status === "CORRECTED") await recordEvent({ leadId: lead.id, actorType: "DRIVER", type: "CORRECTION", message: `Driver corrected ${action.key.replace(/_/g, " ")}` });
      return { ok: true };
    }
    case "unanswered_question": {
      await db.unansweredQuestion.create({ data: { leadId: lead.id, callAttemptId: attemptId, question: redactText(action.question).slice(0, 1000) } });
      await upsertTask(lead.id, "UNANSWERED_QUESTION", "Driver question needs Molly's answer", lead.assignedToId, redactText(action.question).slice(0, 500), undefined, `question:${attemptId}:${action.question.slice(0, 60)}`);
      await recordEvent({ leadId: lead.id, actorType: "AI", type: "UNANSWERED_QUESTION", message: `Question captured for recruiter (no approved answer): "${redactText(action.question).slice(0, 200)}"`, data: { reason: action.reason } });
      return { ok: true };
    }
    case "offer_discussed": {
      await db.lead.update({ where: { id: lead.id }, data: { lastOfferVersionId: attempt.offerVersionId ?? lead.lastOfferVersionId } });
      await recordEvent({ leadId: lead.id, actorType: "AI", type: "OFFER_DISCUSSED", message: `Approved facts shared: ${action.factKeys.join(", ")}`, data: { offerVersionId: attempt.offerVersionId, factKeys: action.factKeys } });
      return { ok: true };
    }
    case "opt_out":
      await optOutLead(lead.id, "Driver asked during AI call", { type: "DRIVER" });
      return { ok: true };
    case "wrong_number":
      await db.suppression.upsert({ where: { phoneE164: lead.phoneE164 }, create: { phoneE164: lead.phoneE164, reason: "WRONG_NUMBER", source: `AI call ${attemptId}` }, update: {} });
      await advancePipeline(lead.id, "CLOSED", db, { force: true });
      await recordEvent({ leadId: lead.id, actorType: "AI", type: "WRONG_NUMBER", message: "Wrong number reported; number suppressed" });
      return { ok: true };
    case "request_transfer":
      return requestTransfer(attemptId, action.reason);
    case "flag_handoff":
      await createHandoff(lead.id, action.reason, { callAttemptId: attemptId, note: redactText(action.note) });
      return { ok: true };
    case "schedule_callback": {
      const at = action.at ? new Date(action.at) : null;
      await db.lead.update({ where: { id: lead.id }, data: { callbackAt: at } });
      await advancePipeline(lead.id, "CALLBACK_SCHEDULED");
      await upsertTask(lead.id, "CALLBACK", at ? `Callback agreed: ${formatLocal(at, lead.timezone)}` : "Driver asked for a follow-up (time not set)", lead.assignedToId, redactText(action.raw).slice(0, 300), at ?? undefined, `callback:${attemptId}`);
      if (at) await scheduleLeadCall(lead.id, { at, reason: "Agreed callback" });
      await recordEvent({ leadId: lead.id, actorType: "AI", type: "CALLBACK", message: at ? `Callback agreed for ${formatLocal(at, lead.timezone)} (driver local)` : "Follow-up requested; recruiter to set time" });
      return { ok: true };
    }
    case "send_cdl_link": {
      const r = await sendCdlLink(lead.id, attemptId, { verbalConsent: true });
      return { ok: r.sent, detail: r.reason };
    }
    case "sensitive_data_warning":
      await recordEvent({ leadId: lead.id, actorType: "AI", type: "SENSITIVE_DATA", message: "Driver began sharing sensitive data; agent declined and it was redacted from records" });
      return { ok: true };
    case "injection_attempt":
      await recordEvent({ leadId: lead.id, actorType: "AI", type: "SECURITY", message: "Driver tried to change agent rules or obtain promises; refused" });
      return { ok: true };
    case "set_outcome":
      await db.callAttempt.update({ where: { id: attemptId }, data: { outcome: action.outcome } });
      return { ok: true };
  }
}

async function maybeUpdateLocation(leadId: string, value: string) {
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
  const zip = value.match(/\b(\d{5})\b/)?.[1];
  const st = value.match(/^[A-Z]{2}$/)?.[0];
  const { resolveTimezone } = await import("./timezone");
  const data: Prisma.LeadUpdateInput = {};
  if (zip && !lead.zip) data.zip = zip;
  if (st && !lead.state) data.state = st;
  if (!lead.timezone) {
    const tz = resolveTimezone(st ?? lead.state, zip ?? lead.zip);
    if (tz.timezone) { data.timezone = tz.timezone; data.timezoneSource = tz.source; }
  }
  if (Object.keys(data).length) await db.lead.update({ where: { id: leadId }, data });
}

// ---------------------------------------------------------------------------
// 5. Transfers. Success is never reported without a provider confirmation.
// ---------------------------------------------------------------------------
export async function requestTransfer(attemptId: string, reason: "HUMAN_REQUESTED" | "UNKNOWN_QUESTION" | "ELIGIBILITY_EXCEPTION" | "TECHNICAL"): Promise<ActionResult> {
  const attempt = await db.callAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { lead: { include: { assignedTo: true } } } });
  const lead = attempt.lead;
  const provider = getAdapters().voice;
  let recruiter = lead.assignedTo && lead.assignedTo.active && lead.assignedTo.availableForTransfer && lead.assignedTo.transferPhoneE164 ? lead.assignedTo : null;
  if (!recruiter) recruiter = await db.user.findFirst({ where: { orgId: lead.orgId, active: true, availableForTransfer: true, transferPhoneE164: { not: null } } });

  if (!recruiter || !provider.supportsLiveTransfer() || !attempt.providerCallId) {
    const why = !recruiter ? "No recruiter marked available for live transfer" : "Provider cannot transfer this call";
    await createHandoff(lead.id, reason, { callAttemptId: attemptId, transferStatus: "FAILED", note: why });
    await transferFailedTask(lead.id, attemptId, lead.assignedToId, why);
    return { ok: false, transfer: "failed", detail: why };
  }
  const handoff = await createHandoff(lead.id, reason, { callAttemptId: attemptId, transferStatus: "ATTEMPTING", note: `Transfer requested to ${recruiter.name}` });
  try {
    const r = await provider.transferCall(attempt.providerCallId, recruiter.transferPhoneE164!);
    await recordEvent({ leadId: lead.id, actorType: "AI", type: "TRANSFER_REQUESTED", message: `Live transfer to ${recruiter.name} requested; waiting for provider confirmation`, data: { handoffId: handoff.id, detail: r.detail } });
  } catch (e) {
    await db.handoff.update({ where: { id: handoff.id }, data: { transferStatus: "FAILED" } });
    await transferFailedTask(lead.id, attemptId, recruiter.id, (e as Error).message);
    return { ok: false, transfer: "failed", detail: (e as Error).message };
  }
  await enqueue("transfer.timeout", { handoffId: handoff.id }, { runAt: new Date(Date.now() + 90_000), idempotencyKey: `transfer-timeout:${handoff.id}` });
  return { ok: true, transfer: "pending" };
}

async function transferFailedTask(leadId: string, attemptId: string, assignedToId: string | null, why: string) {
  await upsertTask(leadId, "TRANSFER_FAILED", "Live transfer did not connect: call the driver back", assignedToId, why, new Date(), `transfer-failed:${attemptId}`);
  await recordEvent({ leadId, actorType: "SYSTEM", type: "TRANSFER_FAILED", message: `Live transfer not completed (${why}); callback task created` });
}

async function applyTransferEvent(attemptId: string, leadId: string, ev: VoiceEvent) {
  const handoff = await db.handoff.findFirst({ where: { callAttemptId: attemptId, transferStatus: "ATTEMPTING" }, orderBy: { createdAt: "desc" } });
  if (!handoff) return false;
  if (ev.type === "transfer_succeeded") {
    await db.handoff.update({ where: { id: handoff.id }, data: { transferStatus: "CONFIRMED" } });
    await advancePipeline(leadId, "HANDED_OFF");
    await recordEvent({ leadId, actorType: "PROVIDER", type: "TRANSFER_CONFIRMED", message: "Provider confirmed the live transfer to a human recruiter" });
    return true;
  }
  if (ev.type === "transfer_failed") {
    await db.handoff.update({ where: { id: handoff.id }, data: { transferStatus: "FAILED" } });
    await transferFailedTask(leadId, attemptId, handoff.recruiterId, "Provider reported transfer failure");
    return true;
  }
  return false;
}

export async function transferTimeoutJob(job: Job) {
  const { handoffId } = job.payload as { handoffId: string };
  const h = await db.handoff.findUnique({ where: { id: handoffId } });
  if (!h || h.transferStatus !== "ATTEMPTING") return;
  await db.handoff.update({ where: { id: handoffId }, data: { transferStatus: "FAILED" } });
  await transferFailedTask(h.leadId, h.callAttemptId ?? "none", h.recruiterId, "No transfer confirmation received from provider");
}

// ---------------------------------------------------------------------------
// 6. Reconciliation of uncertain provider outcomes
// ---------------------------------------------------------------------------
export async function reconcileCallJob(job: Job) {
  const { attemptId } = job.payload as { attemptId: string };
  const a = await db.callAttempt.findUnique({ where: { id: attemptId } });
  if (!a || a.status !== "UNKNOWN") return;
  if (!a.providerCallId) {
    // We never received an ID; the provider idempotency key (attempt id) makes a later retry safe.
    await db.callAttempt.update({ where: { id: attemptId }, data: { status: "FAILED", statusRank: TERMINAL, outcome: "TECHNICAL_FAILURE", errorMessage: "Reconciled: no provider call ID was ever issued", endedAt: new Date() } });
    await recordEvent({ leadId: a.leadId, actorType: "SYSTEM", type: "RECONCILED", message: "Uncertain call reconciled as not placed" });
    return;
  }
  const st = await getAdapters().voice.getCallStatus(a.providerCallId);
  const map: Record<string, CallStatus> = { completed: "COMPLETED", no_answer: "NO_ANSWER", busy: "BUSY", voicemail: "VOICEMAIL", failed: "FAILED", not_found: "FAILED" };
  if (map[st.status]) {
    await db.callAttempt.update({ where: { id: attemptId }, data: { status: "IN_PROGRESS", statusRank: STATUS_RANK.IN_PROGRESS } });
    await ingestVoiceEvent({ provider: a.provider, eventId: `reconcile:${attemptId}`, type: "call_ended", attemptId, status: map[st.status] });
  } else {
    throw new Error(`Call still ${st.status}; will reconcile again`);
  }
}

// ---------------------------------------------------------------------------
// 7. Demo call simulator (mock provider only)
// ---------------------------------------------------------------------------
export async function simulateCallJob(job: Job) {
  const { attemptId, providerCallId, personaKey } = job.payload as { attemptId: string; providerCallId: string; personaKey: string };
  const attempt = await db.callAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { lead: { include: { campaign: true, org: true, screening: true } } } });
  if (attempt.statusRank >= TERMINAL) return; // already finished (job re-delivered after restart)
  if (!attempt.isDemo) throw new Error("Simulator refuses non-demo records");
  const persona = personaByKey(personaKey);
  const lead = attempt.lead;
  const P = getAdapters().voice.key;
  const ev = (type: VoiceEvent["type"], extra: Partial<VoiceEvent> = {}) =>
    ingestVoiceEvent({ provider: P, eventId: `${providerCallId}:${type}:${extra.status ?? ""}`, type, providerCallId, ...extra });

  await ev("call_started");
  await ev("call_ringing");
  if (persona.connect === "no_answer" || persona.connect === "busy" || persona.connect === "failed") {
    mockCalls.set(providerCallId, { status: persona.connect === "failed" ? "failed" : persona.connect });
    await ev("call_ended", { status: persona.connect === "no_answer" ? "NO_ANSWER" : persona.connect === "busy" ? "BUSY" : "FAILED", summary: `Simulated: ${persona.label}` });
    return;
  }
  await ev("call_answered");
  mockCalls.set(providerCallId, { status: "in_progress" });

  const settings = await getSettings();
  const offer = attempt.offerVersionId ? await db.offerVersion.findUnique({ where: { id: attempt.offerVersionId } }) : null;
  const { FactsSchema } = await import("./knowledge");
  const facts = offer ? FactsSchema.parse(offer.facts) : [];
  const fill = (s: string) => s.replace(/\{company\}/g, lead.org.name).replace(/\{recruiterPhone\}/g, "the number in our text");
  const known: Record<string, string> = {};
  for (const s of lead.screening) if (s.reportedValue && s.status !== "UNCLEAR") known[s.key] = s.reportedValue;
  if (lead.state || lead.zip) known.home_location ??= [lead.state, lead.zip].filter(Boolean).join(" ");

  const brain = new RecruitingBrain({
    companyName: lead.org.name, recruiterName: "Molly", driverFirstName: lead.firstName, driverTimezone: lead.timezone,
    knownSlots: known, facts, disclosure: fill(settings.aiDisclosure),
    recordingNotice: settings.recordingEnabled ? settings.recordingNotice : null,
    voicemailMessage: fill(settings.voicemailMessage), uploadLinkTtlMinutes: settings.uploadLinkTtlMinutes, cdlBySms: settings.cdlBySms,
    slots: (settings.screeningConfig as never) ?? undefined,
  });

  const transcript: { speaker: string; text: string; at: string; latencyMs?: number }[] = [];
  const latencies: number[] = [];
  const t0 = performance.now();
  let turn = brain.start();
  transcript.push({ speaker: "agent", text: turn.say, at: new Date().toISOString(), latencyMs: Math.round(performance.now() - t0) });
  let driverInput: DriverInput;
  let i = 0;
  let outcome: CallOutcome | null = null;
  let endedByTransfer = false;
  while (!turn.end && i < 40) {
    driverInput = persona.connect === "voicemail" ? { type: "voicemail" } : persona.reply(brain.state, turn.say, i);
    transcript.push({ speaker: "driver", text: driverInput.type === "speech" ? driverInput.text : `[${driverInput.type}]`, at: new Date().toISOString() });
    const s = performance.now();
    turn = brain.handle(driverInput);
    const lat = performance.now() - s;
    latencies.push(lat);
    transcript.push({ speaker: "agent", text: turn.say, at: new Date().toISOString(), latencyMs: Math.round(lat) });
    for (const act of turn.actions) {
      const res = await applyAgentAction(attemptId, act);
      if (act.type === "set_outcome") outcome = act.outcome;
      if (act.type === "request_transfer") {
        let ok = false;
        if (res.transfer === "pending") {
          ok = !persona.transferFails;
          await ev(ok ? "transfer_succeeded" : "transfer_failed");
        }
        turn = brain.handle({ type: "transfer_result", ok });
        transcript.push({ speaker: "agent", text: turn.say, at: new Date().toISOString() });
        for (const a2 of turn.actions) { await applyAgentAction(attemptId, a2); if (a2.type === "set_outcome") outcome = a2.outcome; }
        if (ok) endedByTransfer = true;
        if (turn.end) break;
      }
    }
    i++;
  }
  const status: CallStatus = outcome === "VOICEMAIL_LEFT" ? "VOICEMAIL" : "COMPLETED";
  mockCalls.set(providerCallId, { status: status === "VOICEMAIL" ? "voicemail" : "completed" });
  const slots = Object.entries(brain.state.slots).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v!.value}`).join("; ");
  const sorted = [...latencies].sort((a, b) => a - b);
  await ev("call_ended", {
    status, outcome: outcome ?? "INCOMPLETE",
    summary: `SIMULATED CALL with synthetic persona "${persona.label}". Outcome: ${(outcome ?? "INCOMPLETE").toLowerCase().replace(/_/g, " ")}${endedByTransfer ? " (transferred to human)" : ""}. ${slots ? `Driver reported: ${slots}.` : ""}${brain.state.unanswered.length ? ` Unanswered: ${brain.state.unanswered.join(" | ")}` : ""}`,
    transcript,
    metrics: {
      simulated: true,
      note: "Brain decision latency only. Real speech latency (ASR+LLM+TTS+network) must be measured on live provider calls.",
      turns: latencies.length,
      decisionLatencyMsP50: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100 : null,
      decisionLatencyMsMax: sorted.length ? Math.round(sorted[sorted.length - 1] * 100) / 100 : null,
    },
  });
}

export async function handoffEvaluateJob(job: Job) {
  const { leadId } = job.payload as { leadId: string };
  await evaluateHandoffReadiness(leadId);
}

export async function syncSourceJob(job: Job) {
  const { leadId } = job.payload as { leadId: string };
  const recs = await db.leadSourceRecord.findMany({ where: { leadId } });
  for (const r of recs) {
    // Only the Google Sheets connector supports write-back; file and manual sources have nothing to update.
    if (r.sourceSystem !== SHEETS_SOURCE) await db.leadSourceRecord.update({ where: { id: r.id }, data: { syncStatus: "NOT_APPLICABLE" } });
  }
  if (recs.some((r) => r.sourceSystem === SHEETS_SOURCE)) await writeBackLeadStatus(leadId);
}

/** Per-call values the voice agent's prompt refers to as {{name}}. */
export async function callVariables(
  lead: { id: string; orgId: string; firstName: string | null; timezone: string | null; createdAt?: Date; reengagedAt?: Date | null; permissions: { scope: string; revokedAt: Date | null; grantedAt: Date }[] },
  attemptId: string, offerVersionId: string, now = new Date(),
): Promise<Record<string, string>> {
  const sources = await db.leadSourceRecord.findMany({ where: { leadId: lead.id }, select: { raw: true } });
  return {
    driver_first_name: lead.firstName ?? "", company_name: (await db.organization.findUnique({ where: { id: lead.orgId } }))?.name ?? "",
    offer_version_id: offerVersionId, attempt_id: attemptId,
    driver_timezone: lead.timezone ?? "unknown", ...(await transferVariables(lead.orgId)),
    // Sheet leads arrive within a minute of applying, so the import time stands in when no permission date was recorded.
    applied_when: appliedWhen(lead.permissions.find((p) => p.scope === "AI_CALL" && !p.revokedAt)?.grantedAt ?? lead.createdAt ?? null, now),
    time_greeting: timeGreeting(lead.timezone, now),
    position_applied: appliedPosition(sources.map((r) => r.raw)),
    follow_up: lead.reengagedAt ? "yes" : "no",
  };
}

// "Good morning/afternoon/evening" in the driver's local time; Central time when the timezone is unknown.
export function timeGreeting(tz: string | null | undefined, now: Date): string {
  let hour = 12;
  try {
    hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz || "America/Chicago", hour: "numeric", hourCycle: "h23" }).format(now));
  } catch {
    hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23" }).format(now));
  }
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

// The position named on the driver's application (lead form or sheet column), if any.
export function appliedPosition(raws: unknown[]): string {
  for (const raw of raws) {
    if (!raw || typeof raw !== "object") continue;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!/position|job|role|driver.?type|solo.?or.?team/i.test(k) || typeof v !== "string") continue;
      const t = v.toLowerCase();
      if (t.includes("team")) return "a team driver position";
      if (t.includes("solo")) return "a solo driver position";
    }
  }
  return "a truck driving position";
}

// Molly's direct line for the Retell transfer tool and the voicemail callback number.
async function transferVariables(orgId: string): Promise<Record<string, string>> {
  const r = await db.user.findFirst({ where: { orgId, availableForTransfer: true, transferPhoneE164: { not: null } } });
  const phone = r?.transferPhoneE164 ?? "";
  return { transfer_number: phone, recruiter_phone: phone };
}

// Rounded, truthful phrase for when the driver applied, from the recorded call permission date.
export function appliedWhen(appliedAt: Date | null, now: Date): string {
  if (!appliedAt) return "a while back";
  const mins = (now.getTime() - appliedAt.getTime()) / 60_000;
  if (mins < 60) return "just a few minutes ago";
  if (mins < 12 * 60) return "earlier today";
  const days = Math.floor(mins / 1440);
  if (days < 2) return "recently";
  if (days < 7) return "a few days ago";
  if (days < 14) return "about a week ago";
  if (days < 25) return `about ${Math.round(days / 7)} weeks ago`;
  if (days < 45) return "about a month ago";
  if (days < 365) return `about ${Math.round(days / 30)} months ago`;
  return "over a year ago";
}
