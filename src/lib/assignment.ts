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

/** A recruiter hands a lead to another recruiter (any user may, for leads they can see). */
export async function transferLead(leadId: string, toUserId: string, by: { id: string; name: string }) {
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, include: { assignedTo: true } });
  const to = await db.user.findFirst({ where: { id: toUserId, orgId: lead.orgId, active: true } });
  if (!to) throw new Error("Recruiter not found or inactive");
  if (lead.assignedToId === to.id) return { changed: false, to: to.name };
  await assignLead(leadId, to.id, "MANUAL", by.id);
  await recordEvent({ leadId, actorType: "USER", actorId: by.id, type: "TRANSFERRED", message: `Lead transferred from ${lead.assignedTo?.name ?? "unassigned"} to ${to.name} by ${by.name}` });
  return { changed: true, to: to.name };
}

// "Dennis" tab and login "Denis": letters only, doubled letters once.
const squeeze = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "").replace(/(.)\1+/g, "$1");

/** The tab of the lead sheet that belongs to this user: the one set on Users, else the one named like them. Demo users get none. */
export function tabForUser(u: { name: string; sheetTab: string | null }, tabs: string[]): string | null {
  if (u.sheetTab?.trim()) return u.sheetTab.trim();
  if (/demo/i.test(u.name)) return null;
  const first = squeeze(u.name.trim().split(/\s+/)[0] ?? "");
  return (first.length >= 3 && tabs.find((t) => squeeze(t) === first)) || null;
}

/**
 * A recruiter moved leads from the Pool to their own tab in the lead sheet: the leads go to
 * that recruiter on the site too. The tab is found by the recruiter's name (or set on Users).
 */
export async function assignFromSheetTabs(rows: { phoneE164: string; tab: string }[]) {
  if (!rows.length) return 0;
  const tabs = [...new Set(rows.map((r) => r.tab.trim()))];
  const users = await db.user.findMany({ where: { active: true } });
  const byTab = new Map<string, (typeof users)[number][]>();
  for (const u of users) {
    const t = tabForUser(u, tabs)?.toLowerCase();
    if (t) byTab.set(t, [...(byTab.get(t) ?? []), u]);
  }
  const tabOf = new Map(rows.map((r) => [r.phoneE164, r.tab.trim()]));
  const leads = await db.lead.findMany({ where: { phoneE164: { in: [...tabOf.keys()] }, isDemo: false }, select: { id: true, orgId: true, phoneE164: true, assignedToId: true } });
  let moved = 0;
  for (const l of leads) {
    const tab = tabOf.get(l.phoneE164)!;
    // Two logins for one tab (e.g. two Dennises): nobody is guessed.
    const owners = (byTab.get(tab.toLowerCase()) ?? []).filter((u) => u.orgId === l.orgId);
    const u = owners.length === 1 ? owners[0] : null;
    if (!u || l.assignedToId === u.id) continue;
    await assignLead(l.id, u.id, "MANUAL", null);
    await recordEvent({ leadId: l.id, actorType: "SYSTEM", type: "TRANSFERRED", message: `Assigned to ${u.name}: lead is in the ${tab} tab of the lead sheet` });
    moved++;
  }
  return moved;
}
