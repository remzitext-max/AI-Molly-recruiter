import type { JobHandler } from "./queue";
import { attemptCallJob, handoffEvaluateJob, reconcileCallJob, simulateCallJob, syncSourceJob, transferTimeoutJob } from "../calls";
import { sendCdlLink } from "../messaging";
import { runRetentionSweep } from "../documents";
import { pollGoogleSheet } from "../sheets-sync";
import { db } from "../db";
import { sendCallReport, sendDocumentToTelegram } from "../telegram";

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
};
