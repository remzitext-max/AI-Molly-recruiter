// Shared intake for leads from video ads (YouTube / TikTok): the Google lead form
// webhook and the public /apply page both land here.
import { config } from "./config";
import { db } from "./db";
import { ingestLead, type IngestResult } from "./leads";
import { recordEvent } from "./activity";
import { enqueue } from "./jobs/queue";
import { adLeadRow } from "./ad-leads-sheet";
import type { AdLead } from "./ad-leads";

export async function acceptAdLead(p: AdLead): Promise<IngestResult | { result: "no_campaign" }> {
  const isDemo = config.mode === "demo";
  const campaign = await db.campaign.findFirst({ where: config.adLeadsCampaignId ? { id: config.adLeadsCampaignId } : { isDemo }, orderBy: { createdAt: "asc" } });
  if (!campaign) return { result: "no_campaign" };
  const r = await ingestLead(p.lead, { orgId: campaign.orgId, campaignId: campaign.id, isDemo: isDemo || campaign.isDemo, scheduleOutreach: !p.sapYes });
  if (r.result === "created" && p.sapYes) await recordEvent({ leadId: r.leadId, actorType: "SYSTEM", type: "NOTE", message: "Answered yes to SAP on the ad form; no automatic call" });
  if ((r.result === "created" || r.result === "merged") && config.adLeadsSheetId) {
    await enqueue("sheet.ad-lead", { row: adLeadRow(p, r.result === "merged" ? "already in system" : p.sapYes ? "SAP yes: no call" : "calling") }, { idempotencyKey: `sheet.ad-lead:${r.leadId}`, maxAttempts: 8 });
  }
  return r;
}
