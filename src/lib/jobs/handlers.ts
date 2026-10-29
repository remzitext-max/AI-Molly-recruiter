import type { JobHandler } from "./queue";
import { attemptCallJob, handoffEvaluateJob, reconcileCallJob, simulateCallJob, syncSourceJob, transferTimeoutJob } from "../calls";
import { pollRingCentralInbound, sendCdlLink, sendMissedCallText } from "../messaging";
import { runRetentionSweep } from "../documents";
import { pollGoogleSheet } from "../sheets-sync";
import { pollTeamSheets } from "../team-sheets";
import { db } from "../db";
import { sendCallReport, sendConsentToTelegram, sendDocumentToTelegram, sendHiredToTelegram, sendRecruiterCallReminder, sendSmsReplyToTelegram } from "../telegram";
import { fetchTelnyxTranscript } from "../telnyx-transcript";
import { fillScreeningFromTranscript } from "../transcript-extract";
import { log } from "../redact";
import { fetchRecording } from "../recordings";
import { reengageScan } from "../reengage";
import { readDocument } from "../document-read";
import { syncHiringFromSheet } from "../hiring";
import { transcribeUpload } from "../recruiter-upload";
import { sendMetaStageEvent, syncMetaLeads, type MetaStage } from "../meta";

export const handlers: Record<string, JobHandler> = {
  "lead.attempt-call": attemptCallJob,
  "call.simulate": simulateCallJob,
  "call.reconcile": reconcileCallJob,
  "transfer.timeout": transferTimeoutJob,
  "handoff.evaluate": handoffEvaluateJob,
  "lead.sync-source": syncSourceJob,
  "sms.send-cdl-link": async (job) => {
    const { leadId } = job.payload as { leadId: string };
    await sendCdlLink(leadId, null, { verbalConsent: false });
  },
  "source.google-sheets.poll": async () => {
    await pollGoogleSheet();
    await pollTeamSheets();
    // One poll job per interval accumulates; keep two days of them for troubleshooting.
    await db.job.deleteMany({ where: { type: "source.google-sheets.poll", status: "DONE", updatedAt: { lt: new Date(Date.now() - 2 * 86400_000) } } });
  },
  "maintenance.retention": async () => { await runRetentionSweep(); },
  "notify.telegram-call-report": async (job) => {
    const { attemptId } = job.payload as { attemptId: string };
    // Give the call recording up to 4 min after the call so it goes with the card.
    const a = await db.callAttempt.findUnique({ where: { id: attemptId }, select: { recordingKey: true, startedAt: true, endedAt: true, provider: true, isDemo: true } });
    if (a && a.provider === "telnyx" && !a.isDemo && a.startedAt && !a.recordingKey && a.endedAt && Date.now() - a.endedAt.getTime() < 4 * 60_000) {
      return { rescheduleAt: new Date(Date.now() + 30_000), reason: "WAITING_FOR_RECORDING" };
    }
    await sendCallReport(attemptId);
  },
  "sms.missed-call": async (job) => {
    const { leadId, attemptId } = job.payload as { leadId: string; attemptId: string };
    await sendMissedCallText(leadId, attemptId);
  },
  "notify.telegram-sms-reply": async (job) => {
    const { leadId, text } = job.payload as { leadId: string; text: string };
    await sendSmsReplyToTelegram(leadId, text);
  },
  "source.google-sheets.hiring": async () => {
    await syncHiringFromSheet();
    await db.job.deleteMany({ where: { type: "source.google-sheets.hiring", status: { in: ["DONE", "DEAD"] }, updatedAt: { lt: new Date(Date.now() - 2 * 86400_000) } } });
  },
  "notify.telegram-hired": async (job) => {
    const { leadId, by } = job.payload as { leadId: string; by: string };
    await sendHiredToTelegram(leadId, by);
  },
  "notify.recruiter-call-reminder": async (job) => {
    const { leadId, at } = job.payload as { leadId: string; at: string };
    await sendRecruiterCallReminder(leadId, new Date(at));
  },
  "lead.reengage-scan": async () => { await reengageScan(); },
  "document.read": async (job) => {
    const { documentId } = job.payload as { documentId: string };
    await readDocument(documentId);
  },
  "meta.sync-leads": async () => { await syncMetaLeads(); },
  "meta.send-event": async (job) => {
    const { leadId, stage } = job.payload as { leadId: string; stage: MetaStage };
    return sendMetaStageEvent(leadId, stage);
  },
  "call.fetch-recording": async (job) => {
    const { attemptId } = job.payload as { attemptId: string };
    await fetchRecording(attemptId);
  },
  "notify.telegram-document": async (job) => {
    const { documentId } = job.payload as { documentId: string };
    await sendDocumentToTelegram(documentId);
  },
  "sms.poll-inbound": async () => {
    await pollRingCentralInbound();
    await db.job.deleteMany({ where: { type: "sms.poll-inbound", status: { in: ["DONE", "DEAD"] }, updatedAt: { lt: new Date(Date.now() - 86400_000) } } });
  },
  "call.fetch-transcript": async (job) => {
    const { attemptId } = job.payload as { attemptId: string };
    // The Telegram card waits for this job; send it now on success or on the last try.
    const releaseCard = () => db.job.updateMany({ where: { idempotencyKey: `telegram:${attemptId}`, status: "PENDING" }, data: { runAt: new Date() } });
    try {
      await fetchTelnyxTranscript(attemptId);
    } catch (e) {
      if (job.attempts >= job.maxAttempts) await releaseCard();
      throw e;
    }
    await fillScreeningFromTranscript(attemptId).catch((e) => log.error("screening from transcript failed", { attemptId, error: (e as Error).message }));
    await releaseCard();
  },
  "call.transcribe-upload": async (job) => {
    const { attemptId } = job.payload as { attemptId: string };
    await transcribeUpload(attemptId);
  },
  "notify.telegram-consent": async (job) => {
    const { consentId } = job.payload as { consentId: string };
    await sendConsentToTelegram(consentId);
  },
};
