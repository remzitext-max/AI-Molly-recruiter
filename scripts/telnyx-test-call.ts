// Places ONE Telnyx AI test call to the phone number given on the command line,
// meant for the owner's own phone. It works while APP_MODE=demo, so nothing else
// is switched to live: SMS, Sheets and the queue stay on mocks, and the worker
// still never dials (live contact stays off).
//   docker compose exec web npx tsx scripts/telnyx-test-call.ts +1XXXXXXXXXX [FirstName]
import { config } from "../src/lib/config";
import { db } from "../src/lib/db";
import { callVariables, STATUS_RANK } from "../src/lib/calls";
import { getActiveOfferVersion } from "../src/lib/knowledge";
import { TelnyxVoiceAgent } from "../src/adapters/live/telnyx";

async function main() {
  const to = process.argv[2] ?? "";
  const firstName = process.argv[3] ?? "Test";
  if (!/^\+1\d{10}$/.test(to)) throw new Error("Give your own US number like +18165551234");
  if (config.voiceProvider !== "telnyx") throw new Error("VOICE_PROVIDER is not telnyx in .env");

  const org = await db.organization.findFirst({ where: { isMain: true }, orderBy: { createdAt: "asc" } });
  if (!org) throw new Error("No organization in the database");
  const campaigns = await db.campaign.findMany({ where: { orgId: org.id, isDemo: false, offerId: { not: null } } });
  let campaign = null;
  let offer = null;
  for (const c of campaigns) {
    const v = await getActiveOfferVersion(c.offerId);
    if (v && !v.synthetic) { campaign = c; offer = v; break; }
  }
  if (!campaign || !offer) throw new Error("No real campaign with a published (non-demo) offer");

  // One test lead per number, never a demo record, so the live adapter accepts it.
  let lead = await db.lead.findFirst({ where: { orgId: org.id, phoneE164: to, isDemo: false } });
  if (!lead) {
    lead = await db.lead.create({ data: { orgId: org.id, campaignId: campaign.id, firstName, lastName: "(owner test)", phoneE164: to, phoneRaw: to } });
    console.log(`Created test lead ${lead.id}`);
  }
  if (lead.activeAttemptId) throw new Error("A call to this number is already active; wait for it to end");
  const permission = await db.contactPermission.findFirst({ where: { leadId: lead.id, scope: "AI_CALL", revokedAt: null } });
  if (!permission) {
    await db.contactPermission.create({ data: { leadId: lead.id, scope: "AI_CALL", source: "Owner's own phone, test call run by the owner", grantedAt: new Date() } });
  }

  const attempt = await db.callAttempt.create({
    data: { leadId: lead.id, provider: "telnyx", idempotencyKey: `owner-test:${Date.now()}`, status: "SCHEDULED", offerVersionId: offer.id },
  });
  await db.lead.update({ where: { id: lead.id }, data: { activeAttemptId: attempt.id, attemptCount: { increment: 1 } } });

  const withPermissions = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { permissions: true } });
  try {
    const { providerCallId } = await new TelnyxVoiceAgent().startOutboundCall({
      attemptId: attempt.id, leadId: lead.id, toE164: to, isDemoRecord: false, personaKey: null,
      dynamicVariables: await callVariables(withPermissions, attempt.id, offer.id),
    });
    await db.callAttempt.update({ where: { id: attempt.id }, data: { providerCallId, status: "DIALING", statusRank: STATUS_RANK.DIALING } });
    console.log(`Calling ${to} now. Telnyx call ${providerCallId}, attempt ${attempt.id}.`);
  } catch (e) {
    await db.callAttempt.update({ where: { id: attempt.id }, data: { status: "FAILED", statusRank: STATUS_RANK.FAILED, errorMessage: (e as Error).message, endedAt: new Date() } });
    await db.lead.update({ where: { id: lead.id }, data: { activeAttemptId: null } });
    throw e;
  }
}

main()
  .catch((e) => { console.error("TEST CALL FAILED:", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
