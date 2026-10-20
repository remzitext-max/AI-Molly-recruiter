// Durable Postgres-backed job queue. Jobs survive worker restarts: a job whose
// lock is older than LOCK_TIMEOUT is considered abandoned and is picked up again.
import { db, Tx } from "../db";
import type { Job, Prisma } from "@prisma/client";
import { log } from "../redact";

export const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

export type JobType =
  | "lead.attempt-call"
  | "call.simulate"
  | "call.reconcile"
  | "sms.send-cdl-link"
  | "handoff.evaluate"
  | "transfer.timeout"
  | "lead.sync-source"
  | "source.google-sheets.poll"
  | "maintenance.retention"
  | "notify.telegram-call-report";

export async function enqueue(
  type: JobType,
  payload: Prisma.InputJsonValue,
  opts: { runAt?: Date; idempotencyKey?: string; maxAttempts?: number } = {},
  tx: Tx | typeof db = db,
): Promise<Job> {
  if (opts.idempotencyKey) {
    const existing = await tx.job.findUnique({ where: { idempotencyKey: opts.idempotencyKey } });
    if (existing) return existing;
  }
  try {
    return await tx.job.create({
      data: { type, payload, runAt: opts.runAt ?? new Date(), idempotencyKey: opts.idempotencyKey, maxAttempts: opts.maxAttempts ?? 5 },
    });
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2002" && opts.idempotencyKey) {
      return (await tx.job.findUnique({ where: { idempotencyKey: opts.idempotencyKey } }))!;
    }
    throw e;
  }
}

/** Atomically claim due jobs using FOR UPDATE SKIP LOCKED. */
export async function claimJobs(workerId: string, limit = 5): Promise<Job[]> {
  const staleBefore = new Date(Date.now() - LOCK_TIMEOUT_MS);
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "Job" SET status = 'RUNNING', "lockedAt" = now(), "lockedBy" = ${workerId}, attempts = attempts + 1, "updatedAt" = now()
    WHERE id IN (
      SELECT id FROM "Job"
      WHERE ((status = 'PENDING' AND "runAt" <= now()) OR (status = 'RUNNING' AND "lockedAt" < ${staleBefore}))
      ORDER BY "runAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`;
  if (!rows.length) return [];
  return db.job.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
}

export type JobHandler = (job: Job) => Promise<void | { rescheduleAt: Date; reason?: string }>;

export async function runJob(job: Job, handlers: Record<string, JobHandler>) {
  const handler = handlers[job.type];
  if (!handler) {
    await db.job.update({ where: { id: job.id }, data: { status: "DEAD", lastError: `No handler for ${job.type}` } });
    return;
  }
  try {
    const res = await handler(job);
    if (res && "rescheduleAt" in res) {
      // Not a failure: e.g. outside contact hours. Keep it queued.
      await db.job.update({
        where: { id: job.id },
        data: { status: "PENDING", runAt: res.rescheduleAt, lockedAt: null, lockedBy: null, attempts: { decrement: 1 }, lastError: res.reason ?? null },
      });
    } else {
      await db.job.update({ where: { id: job.id }, data: { status: "DONE", lockedAt: null, lockedBy: null } });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const dead = job.attempts >= job.maxAttempts;
    const backoff = Math.min(60 * 60 * 1000, 2 ** job.attempts * 15_000);
    log.error(`job ${job.type} ${job.id} failed (attempt ${job.attempts})`, { error: msg });
    await db.job.update({
      where: { id: job.id },
      data: { status: dead ? "DEAD" : "PENDING", runAt: new Date(Date.now() + backoff), lockedAt: null, lockedBy: null, lastError: msg.slice(0, 2000) },
    });
  }
}

/** Process all currently-due jobs (used by tests and the demo "run now" button). */
export async function drainQueue(handlers: Record<string, JobHandler>, workerId = "drain", maxRounds = 50) {
  for (let i = 0; i < maxRounds; i++) {
    const jobs = await claimJobs(workerId, 20);
    if (!jobs.length) return;
    for (const j of jobs) await runJob(j, handlers);
  }
}

export async function retryDeadJob(jobId: string) {
  return db.job.update({ where: { id: jobId }, data: { status: "PENDING", runAt: new Date(), attempts: 0, lastError: null } });
}
