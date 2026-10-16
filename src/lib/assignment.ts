import { db, Tx } from "./db";
import { recordEvent } from "./activity";

/** Pick the next recruiter for a campaign using a row-locked cursor. */
export async function nextRoundRobinRecruiter(tx: Tx, campaignId: string): Promise<string | null> {
  await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${campaignId} FOR UPDATE`;
  const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const recruiters = await tx.user.findMany({
    where: { orgId: campaign.orgId, active: true, inRoundRobin: true, role: "RECRUITER" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!recruiters.length) return null;
  const pick = recruiters[campaign.rrCursor % recruiters.length];
  await tx.campaign.update({ where: { id: campaignId }, data: { rrCursor: { increment: 1 } } });
  return pick.id;
}

export async function assignLead(leadId: string, toUserId: string | null, method: "MANUAL" | "ROUND_ROBIN", byUserId: string | null, tx?: Tx) {
  const run = async (t: Tx) => {
    const lead = await t.lead.findUniqueOrThrow({ where: { id: leadId } });
    if (lead.assignedToId === toUserId) return lead;
    if (toUserId) {
      const u = await t.user.findFirst({ where: { id: toUserId, orgId: lead.orgId, active: true } });
      if (!u) throw new Error("Recruiter not found or inactive");
    }
    const updated = await t.lead.update({ where: { id: leadId }, data: { assignedToId: toUserId } });
    await t.assignmentHistory.create({ data: { leadId, fromUserId: lead.assignedToId, toUserId, method, byUserId } });
    // Open tasks follow the candidate to the new recruiter; history stays on the lead.
    await t.task.updateMany({ where: { leadId, status: "OPEN" }, data: { assignedToId: toUserId } });
    await recordEvent({ leadId, actorType: byUserId ? "USER" : "SYSTEM", actorId: byUserId, type: "ASSIGNED", message: `Assigned (${method.toLowerCase().replace("_", "-")})`, data: { from: lead.assignedToId, to: toUserId } }, t);
    return updated;
  };
  return tx ? run(tx) : db.$transaction(run);
}

/** Ensure a lead has an owner: round-robin when the campaign uses it. */
export async function ensureAssigned(leadId: string, tx: Tx) {
  const lead = await tx.lead.findUniqueOrThrow({ where: { id: leadId }, include: { campaign: true } });
  if (lead.assignedToId) return lead.assignedToId;
  if (lead.campaign.assignmentMode !== "ROUND_ROBIN") return null;
  const pick = await nextRoundRobinRecruiter(tx, lead.campaignId);
  if (pick) await assignLead(leadId, pick, "ROUND_ROBIN", null, tx);
  return pick;
}
