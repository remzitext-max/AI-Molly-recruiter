import type { JobHandler } from "./queue";
import { attemptCallJob, handoffEvaluateJob, reconcileCallJob, simulateCallJob, syncSourceJob, transferTimeoutJob } from "../calls";
import { sendCdlLink } from "../messaging";
import { runRetentionSweep } from "../documents";
import { pollGoogleSheet } from "../sheets-sync";
import { db } from "../db";
import { sendCallReport, sendConsentToTelegram, sendDocumentToTelegram } from "../telegram";
import { fetchTelnyxTranscript } from "../telnyx-transcript";
import { fillScreeningFromTranscript } from "../transcript-extract";
import { log } from "../redact";

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
    // One poll job per interval accumulates; keep two days of them for troubleshooting.
    await db.job.deleteMany({ where: { type: "source.google-sheets.poll", status: "DONE", updatedAt: { lt: new Date(Date.now() - 2 * 86400_000) } } });
  },
  "maintenance.retention": async () => { await runRetentionSweep(); },
  "notify.telegram-call-report": async (job) => {
    const { attemptId } = job.payload as { attemptId: string };
    await sendCallReport(attemptId);
  },
  "notify.telegram-document": async (job) => {
    const { documentId } = job.payload as { documentId: string };
    await sendDocumentToTelegram(documentId);
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
  "notify.telegram-consent": async (job) => {
    const { consentId } = job.payload as { consentId: string };
    await sendConsentToTelegram(consentId);
  },
};
