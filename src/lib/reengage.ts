// Follow-up round for leads Crystal could not reach, or who said no, once a
// campaign's reengageAfterDays have passed since their last call. Each lead gets
// this once; opted-out, stopped (CLOSED) and progressing leads are never touched.
import type { PipelineStatus } from "@prisma/client";
import { db } from "./db";
import { recordEvent } from "./activity";
import { scheduleLeadCall } from "./leads";
import { enqueue } from "./jobs/queue";

const FOLLOW_UP_CALLS = 2;
// Leads still waiting on Crystal (all attempts used) or who said no.
const ELIGIBLE: PipelineStatus[] = ["NEW", "QUEUED", "CONTACTING", "NOT_INTERESTED"];

export async function reengageScan(now = new Date()) {
  const campaigns = await db.campaign.findMany({ where: { reengageAfterDays: { gt: 0 }, paused: false } });
  let queued = 0;
  for (const c of campaigns) {
    const cutoff = new Date(now.getTime() - c.reengageAfterDays * 86400_000);
    const leads = await db.lead.findMany({
      where: {
        campaignId: c.id, reengagedAt: null, optedOutAt: null, activeAttemptId: null, pipelineStatus: { in: ELIGIBLE },
        OR: [{ pipelineStatus: "NOT_INTERESTED" }, { attemptCount: { gte: c.maxAttempts } }],
        calls: { some: {}, none: { createdAt: { gt: cutoff } } },
      },
      take: 50,
    });
    for (const l of leads) {
      if (await db.suppression.findUnique({ where: { phoneE164: l.phoneE164 } })) continue;
      await db.lead.update({
        where: { id: l.id },
        data: { reengagedAt: now, attemptCount: Math.max(0, c.maxAttempts - FOLLOW_UP_CALLS), pipelineStatus: "QUEUED", queueReason: `Follow-up after ${c.reengageAfterDays} days` },
      });
      await recordEvent({ leadId: l.id, actorType: "SYSTEM", type: "REENGAGE", message: `Follow-up round: up to ${FOLLOW_UP_CALLS} more AI calls, ${c.reengageAfterDays} days after the last one` });
      await scheduleLeadCall(l.id, { at: now, reason: `Follow-up after ${c.reengageAfterDays} days` });
      queued++;
    }
  }
  return { queued };
}

/** Called by the worker every minute; runs the scan once an hour. */
export async function scheduleReengageScan(now = Date.now()) {
  await enqueue("lead.reengage-scan", {}, { idempotencyKey: `reengage:${Math.floor(now / 3600_000)}`, maxAttempts: 1 });
}
