import { db } from "./db";
import { DEMO_LEADS } from "./demo-data";
import { ingestLead, scheduleLeadCall } from "./leads";
import { config } from "./config";

/** Create the synthetic demo leads, each pinned to a persona. Demo mode only. */
export async function loadDemoLeads(orgId: string, actorId: string) {
  if (config.mode !== "demo") throw new Error("Demo leads can only be loaded in demo mode");
  const campaign = await db.campaign.findFirst({ where: { orgId, isDemo: true } });
  if (!campaign) throw new Error("No demo campaign; run the seed");
  let created = 0;
  for (const d of DEMO_LEADS) {
    const r = await ingestLead(
      {
        sourceSystem: "DEMO", sourceRecordId: `demo-${d.phone.replace(/\D/g, "")}`, firstName: d.first, lastName: d.last, phone: d.phone, state: d.state, zip: d.zip,
        permission: d.callPermission ? [{ scope: "AI_CALL", source: "SYNTHETIC demo permission (not real consent)", grantedAt: new Date(Date.now() - 86400000).toISOString() }] : [],
        raw: { persona: d.persona, synthetic: true },
      },
      { orgId, campaignId: campaign.id, isDemo: true, actorId, scheduleOutreach: false },
    );
    if (r.result === "created") {
      created++;
      await scheduleLeadCall(r.leadId, { reason: "Demo lead", personaKey: d.persona });
    }
  }
  return created;
}
