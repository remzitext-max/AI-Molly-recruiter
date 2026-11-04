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
  if (r.result !== "invalid" && config.adLeadsSheetId) {
    // Every application gets a row, a repeat one too: recruiters should see a driver who applied again.
    const note = r.result === "created" ? (p.sapYes ? "SAP yes: will not call" : "Will call") : "Applied again (already in system)";
    await enqueue("sheet.ad-lead", { row: adLeadRow(p, note, r.leadId) }, { idempotencyKey: r.result === "created" ? `sheet.ad-lead:${r.leadId}` : undefined, maxAttempts: 8 });
  }
  return r;
}
