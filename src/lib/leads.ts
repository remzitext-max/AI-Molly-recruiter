import type { PipelineStatus, Prisma } from "@prisma/client";
import { db, Tx } from "./db";
import { normalizePhone } from "./phone";
import { resolveTimezoneWithPhone } from "./timezone";
import { recordEvent } from "./activity";
import { ensureAssigned } from "./assignment";
import { enqueue } from "./jobs/queue";
import type { IncomingLead } from "../adapters/types";

export const PIPELINE_RANK: Record<PipelineStatus, number> = {
  NEW: 0, NEEDS_PERMISSION: 0, NEEDS_TIMEZONE: 0, QUEUED: 1, CONTACTING: 2, CALLBACK_SCHEDULED: 3, NOT_INTERESTED: 3,
  INTERESTED: 4, DOCS_REQUESTED: 5, DOCS_RECEIVED: 6, HANDOFF_READY: 7, HANDED_OFF: 8, OPTED_OUT: 99, CLOSED: 99,
};

/** Move pipeline forward only (failed calls never erase progress). Terminal states are sticky. */
export async function advancePipeline(leadId: string, to: PipelineStatus, tx: Tx | typeof db = db, opts: { force?: boolean } = {}) {
  const lead = await tx.lead.findUniqueOrThrow({ where: { id: leadId }, select: { pipelineStatus: true } });
  const cur = PIPELINE_RANK[lead.pipelineStatus];
  if (cur === 99 && !opts.force) return false;
  if (!opts.force && PIPELINE_RANK[to] <= cur && to !== lead.pipelineStatus) return false;
  if (to === lead.pipelineStatus) return false;
  await tx.lead.update({ where: { id: leadId }, data: { pipelineStatus: to } });
  await recordEvent({ leadId, actorType: "SYSTEM", type: "PIPELINE", message: `Pipeline: ${lead.pipelineStatus} → ${to}` }, tx);
  await queueSourceSync(leadId, to, tx);
  return true;
}

/** Queue a progress write-back for leads that came from the Google Sheets connector. */
async function queueSourceSync(leadId: string, to: PipelineStatus, tx: Tx | typeof db) {
  const fromSheet = await tx.leadSourceRecord.count({ where: { leadId, sourceSystem: "GOOGLE_SHEETS" } });
  if (fromSheet) await enqueue("lead.sync-source", { leadId }, { idempotencyKey: `sync:${leadId}:${to}` }, tx);
}

export type IngestResult =
  | { result: "created"; leadId: string }
  | { result: "merged"; leadId: string }
  | { result: "duplicate_source"; leadId: string }
  | { result: "invalid"; error: string };

export interface IngestOpts { orgId: string; campaignId: string; isDemo: boolean; importBatchId?: string; actorId?: string | null; scheduleOutreach?: boolean }

/**
 * Idempotent lead intake used by CSV/XLSX import, manual entry and webhooks.
 * Identity = (sourceSystem, sourceRecordId); the same phone from another
 * source merges into the existing candidate instead of creating outreach twice.
 */
export async function ingestLead(inc: IncomingLead, opts: IngestOpts): Promise<IngestResult> {
  const phone = normalizePhone(inc.phone);
  if (!phone) return { result: "invalid", error: "Invalid phone number" };
  if (!inc.sourceRecordId?.trim()) return { result: "invalid", error: "Missing source record ID" };

  const res = await db.$transaction(async (tx) => {
    // Serialize concurrent intake of the same phone number.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"lead:" + phone}))`;
    const src = await tx.leadSourceRecord.findUnique({ where: { sourceSystem_sourceRecordId: { sourceSystem: inc.sourceSystem, sourceRecordId: inc.sourceRecordId } } });
    if (src) return { result: "duplicate_source" as const, leadId: src.leadId };

    const existing = await tx.lead.findUnique({ where: { orgId_phoneE164: { orgId: opts.orgId, phoneE164: phone } } });
    if (existing) {
      if (existing.isDemo !== opts.isDemo) throw new Error("Cannot merge demo and live records");
      await tx.leadSourceRecord.create({ data: { leadId: existing.id, sourceSystem: inc.sourceSystem, sourceRecordId: inc.sourceRecordId, importBatchId: opts.importBatchId, raw: (inc.raw ?? {}) as Prisma.InputJsonValue } });
      const fill: Prisma.LeadUpdateInput = {};
      if (!existing.firstName && inc.firstName) fill.firstName = inc.firstName;
      if (!existing.lastName && inc.lastName) fill.lastName = inc.lastName;
      if (!existing.email && inc.email) fill.email = inc.email;
      if (!existing.state && inc.state) fill.state = inc.state.toUpperCase();
      if (!existing.zip && inc.zip) fill.zip = inc.zip;
      if (Object.keys(fill).length) await tx.lead.update({ where: { id: existing.id }, data: fill });
      await addPermissions(tx, existing.id, inc, opts);
      await recordEvent({ leadId: existing.id, actorType: "SYSTEM", type: "DUPLICATE_MERGED", message: `Same phone received again from ${inc.sourceSystem}; merged, no new outreach created` }, tx);
      return { result: "merged" as const, leadId: existing.id };
    }

    const tz = resolveTimezoneWithPhone(inc.state, inc.zip, phone);
    const suppressed = await tx.suppression.findUnique({ where: { phoneE164: phone } });
    const lead = await tx.lead.create({
      data: {
        orgId: opts.orgId, campaignId: opts.campaignId, isDemo: opts.isDemo,
        firstName: inc.firstName?.trim() || null, lastName: inc.lastName?.trim() || null,
        phoneE164: phone, phoneRaw: inc.phone, email: inc.email?.trim() || null,
        state: inc.state?.trim().toUpperCase() || null, zip: inc.zip?.trim() || null,
        timezone: tz.timezone, timezoneSource: tz.source,
        pipelineStatus: suppressed ? "OPTED_OUT" : "NEW",
        optedOutAt: suppressed ? new Date() : null,
        sourceRecords: { create: { sourceSystem: inc.sourceSystem, sourceRecordId: inc.sourceRecordId, importBatchId: opts.importBatchId, raw: (inc.raw ?? {}) as Prisma.InputJsonValue } },
      },
    });
    await addPermissions(tx, lead.id, inc, opts);
    await recordEvent({ leadId: lead.id, actorType: opts.actorId ? "USER" : "SYSTEM", actorId: opts.actorId, type: "LEAD_CREATED", message: `Lead received from ${inc.sourceSystem}${opts.isDemo ? " (demo data)" : ""}${suppressed ? "; number is on the suppression list, will not be contacted" : ""}` }, tx);
    if (tz.ambiguous) await recordEvent({ leadId: lead.id, actorType: "SYSTEM", type: "TIMEZONE", message: "State spans several timezones; ZIP or manual timezone needed before automatic calls" }, tx);
    await ensureAssigned(lead.id, tx);
    return { result: "created" as const, leadId: lead.id };
  });

  if (res.result === "created" && opts.scheduleOutreach !== false) await scheduleLeadCall(res.leadId, { reason: "New lead" });
  return res;
}

async function addPermissions(tx: Tx, leadId: string, inc: IncomingLead, opts: IngestOpts) {
  for (const p of inc.permission ?? []) {
    const grantedAt = new Date(p.grantedAt);
    if (isNaN(grantedAt.getTime())) continue;
    const dup = await tx.contactPermission.findFirst({ where: { leadId, scope: p.scope, source: p.source, grantedAt } });
    if (!dup) await tx.contactPermission.create({ data: { leadId, scope: p.scope, source: p.source, grantedAt, evidence: p.evidence, isDemo: opts.isDemo, createdById: opts.actorId ?? null } });
  }
}

/**
 * Queue an outbound call job for a lead. At most one pending call job exists
 * per lead, so duplicate imports/webhooks cannot create duplicate outreach.
 */
export async function scheduleLeadCall(leadId: string, opts: { at?: Date; reason: string; personaKey?: string }) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"leadjob:" + leadId}))`;
    const pending = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Job" WHERE type = 'lead.attempt-call' AND status IN ('PENDING','RUNNING') AND payload->>'leadId' = ${leadId} LIMIT 1`;
    const at = opts.at ?? new Date();
    if (pending.length) {
      if (opts.at) await tx.job.update({ where: { id: pending[0].id }, data: { runAt: at } });
      return pending[0].id;
    }
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: leadId } });
    if (lead.optedOutAt || lead.pipelineStatus === "OPTED_OUT" || lead.pipelineStatus === "CLOSED") return null;
    const job = await enqueue("lead.attempt-call", { leadId, personaKey: opts.personaKey ?? null }, { runAt: at, maxAttempts: 3 }, tx);
    await tx.lead.update({ where: { id: leadId }, data: { nextContactAt: at, queueReason: opts.reason } });
    if (lead.pipelineStatus === "NEW") await tx.lead.update({ where: { id: leadId }, data: { pipelineStatus: "QUEUED" } });
    return job.id;
  });
}

/** Cancel queued outreach for a lead (opt-out, closure). */
export async function cancelPendingOutreach(leadId: string, tx: Tx | typeof db = db) {
  await tx.$executeRaw`UPDATE "Job" SET status = 'CANCELED', "updatedAt" = now() WHERE status = 'PENDING' AND payload->>'leadId' = ${leadId}`;
}

/** A recruiter stops further AI calls for one lead (no suppression; they can still schedule one by hand). */
export async function stopAiCalls(leadId: string, actor: { id: string; name: string }) {
  await db.$transaction(async (tx) => {
    await cancelPendingOutreach(leadId, tx);
    await tx.lead.update({ where: { id: leadId }, data: { nextContactAt: null, queueReason: `AI calls stopped by ${actor.name}` } });
    await advancePipeline(leadId, "CLOSED", tx, { force: true });
    await recordEvent({ leadId, actorType: "USER", actorId: actor.id, type: "AI_CALLS_STOPPED", message: `AI calls stopped by ${actor.name}; no more automatic calls or texts are queued` }, tx);
  });
}

export async function optOutLead(leadId: string, source: string, actor: { type: "USER" | "AI" | "DRIVER" | "SYSTEM"; id?: string | null }) {
  await db.$transaction(async (tx) => {
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: leadId } });
    await tx.lead.update({ where: { id: leadId }, data: { optedOutAt: lead.optedOutAt ?? new Date(), pipelineStatus: "OPTED_OUT", nextContactAt: null, queueReason: "Opted out" } });
    await tx.suppression.upsert({ where: { phoneE164: lead.phoneE164 }, create: { phoneE164: lead.phoneE164, reason: "OPT_OUT", source }, update: {} });
    await tx.contactPermission.updateMany({ where: { leadId, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.uploadToken.updateMany({ where: { leadId, revokedAt: null, completedAt: null }, data: { revokedAt: new Date() } });
    await cancelPendingOutreach(leadId, tx);
    await queueSourceSync(leadId, "OPTED_OUT", tx);
    await recordEvent({ leadId, actorType: actor.type, actorId: actor.id, type: "OPT_OUT", message: `Opted out (${source}). All automated contact stopped; number suppressed for future imports.` }, tx);
  });
}
