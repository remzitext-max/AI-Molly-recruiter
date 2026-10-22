// Facebook lead ads: match our leads to the Facebook lead (by phone) to know the
// campaign and ad, and report pipeline stages back to Meta. Spend and cost per
// lead are shown to admins only; nothing here goes to Telegram.
import type { PipelineStatus } from "@prisma/client";
import { db, type Tx } from "./db";
import { config } from "./config";
import { normalizePhone } from "./phone";
import { recordEvent } from "./activity";
import { enqueue } from "./jobs/queue";
import { listMetaLeads, sendLeadEvent } from "../adapters/live/meta";

const CONN = "meta-leads";

export const metaLeadsConfigured = () => !!(config.meta.accessToken && config.meta.pageId);
export const metaSpendConfigured = () => !!(config.meta.accessToken && config.meta.adAccountId);
export const metaEventsConfigured = () => !!(config.meta.accessToken && config.meta.datasetId);

/** Stage names sent to Meta as CRM events. */
export type MetaStage = PipelineStatus | "HIRED";
export const META_STAGE_EVENTS: Partial<Record<MetaStage, string>> = {
  INTERESTED: "Interested",
  DOCS_RECEIVED: "Documents received",
  HANDOFF_READY: "Qualified",
  HANDED_OFF: "Qualified",
  HIRED: "Hired",
};

/** Pulls recent Facebook leads and stores campaign / ad / form on matching leads. */
export async function syncMetaLeads(now = new Date()) {
  if (!metaLeadsConfigured()) return { matched: 0 };
  const conn = await db.sourceConnection.findUnique({ where: { id: CONN } });
  // First run looks back 30 days; later runs overlap an hour to catch late rows.
  const since = conn?.lastSyncAt ? new Date(conn.lastSyncAt.getTime() - 3600_000) : new Date(now.getTime() - 30 * 86400_000);
  try {
    const leads = await listMetaLeads(since);
    let matched = 0;
    for (const m of leads) {
      const phone = m.phone ? normalizePhone(m.phone) : null;
      if (!phone) continue;
      const r = await db.lead.updateMany({
        where: { phoneE164: phone, fbLeadId: null },
        data: { fbLeadId: m.id, fbCampaign: m.campaign_name?.slice(0, 200) ?? null, fbAd: m.ad_name?.slice(0, 200) ?? null, fbForm: m.form_name?.slice(0, 200) ?? null },
      });
      matched += r.count;
    }
    const org = await db.organization.findFirst();
    await db.sourceConnection.upsert({
      where: { id: CONN },
      create: { id: CONN, orgId: org?.id ?? "", lastSyncAt: now, lastSummary: { fetched: leads.length, matched }, lastError: null },
      update: { lastSyncAt: now, lastSummary: { fetched: leads.length, matched }, lastError: null },
    });
    return { matched, fetched: leads.length };
  } catch (e) {
    await db.sourceConnection.upsert({ where: { id: CONN }, create: { id: CONN, orgId: "", lastError: (e as Error).message.slice(0, 500) }, update: { lastError: (e as Error).message.slice(0, 500) } });
    throw e;
  }
}

/** Called by the worker every minute; syncs every 15 min. */
export async function scheduleMetaSync(now = Date.now()) {
  if (config.mode !== "live" || !metaLeadsConfigured()) return;
  await enqueue("meta.sync-leads", {}, { idempotencyKey: `meta-sync:${Math.floor(now / 900_000)}`, maxAttempts: 1 });
}

/** Queues the Meta event for a pipeline stage (from advancePipeline). */
export async function queueMetaStageEvent(leadId: string, to: MetaStage, tx: Tx | typeof db) {
  if (!META_STAGE_EVENTS[to] || !metaEventsConfigured() || config.mode !== "live") return;
  await enqueue("meta.send-event", { leadId, stage: to }, { idempotencyKey: `meta:${leadId}:${META_STAGE_EVENTS[to]}`, maxAttempts: 4 }, tx);
}

export async function sendMetaStageEvent(leadId: string, stage: MetaStage, now = new Date()): Promise<void | { rescheduleAt: Date; reason: string }> {
  const lead = await db.lead.findUnique({ where: { id: leadId } });
  const eventName = META_STAGE_EVENTS[stage];
  if (!lead || lead.isDemo || !eventName) return;
  // Wait for the lead sync to find the Facebook lead ID (better match) for up to 2 hours.
  // Without Page access there is no sync to wait for: send matched by phone.
  if (!lead.fbLeadId && metaLeadsConfigured() && now.getTime() - lead.createdAt.getTime() < 2 * 3600_000) {
    return { rescheduleAt: new Date(now.getTime() + 15 * 60_000), reason: "WAITING_FOR_FB_LEAD_ID" };
  }
  const r = await sendLeadEvent({ eventName, time: now, fbLeadId: lead.fbLeadId, phoneE164: lead.phoneE164, eventId: `${leadId}:${eventName}` });
  await recordEvent({ leadId, actorType: "SYSTEM", type: "META_EVENT", message: `Sent "${eventName}" to Facebook${lead.fbLeadId ? "" : " (matched by phone only)"}${r.events_received ? "" : ": not confirmed"}` });
}
