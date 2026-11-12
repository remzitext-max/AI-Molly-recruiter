// Referrals: at the end of a good call Crystal asks whether the driver knows other drivers looking
// for a job (the company's referral bonus). A friend's name and number become a new lead for a
// recruiter to call. Crystal does not call them: the friend never applied or agreed to AI calls.
import { db } from "./db";
import { normalizePhone } from "./phone";
import { ingestLead } from "./leads";
import { recordEvent } from "./activity";
import { REFERRAL_PREFIX } from "./new-leads";

export const REFERRAL_SOURCE = "REFERRAL";
export const referralPrefix = (referrerLeadId: string) => `${REFERRAL_PREFIX}${referrerLeadId}:`;

export type ReferralResult = { ok: boolean; say: string; leadId?: string };

/** Save one friend the driver on this call referred. */
export async function addReferral(attemptId: string, input: { name?: unknown; phone?: unknown; raw?: unknown }): Promise<ReferralResult> {
  const attempt = await db.callAttempt.findUnique({ where: { id: attemptId }, include: { lead: true } });
  if (!attempt) return { ok: false, say: "Thank them and move on." };
  const referrer = attempt.lead;
  const name = String(input.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const phone = normalizePhone(String(input.phone ?? ""));
  if (!phone) return { ok: false, say: "That number doesn't look complete. Ask the driver to say their friend's number again, digit by digit, including the area code." };
  if (phone === referrer.phoneE164) return { ok: false, say: "That is the driver's own number. Ask for their friend's number instead." };
  const referrerName = [referrer.firstName, referrer.lastName].filter(Boolean).join(" ") || referrer.phoneE164;
  const [first, ...rest] = name.split(" ");
  const r = await ingestLead(
    {
      sourceSystem: REFERRAL_SOURCE, sourceRecordId: `${referralPrefix(referrer.id)}${phone}`,
      firstName: first || undefined, lastName: rest.join(" ") || undefined, phone,
      raw: { referredBy: referrer.id, referrerName, referrerPhone: referrer.phoneE164, attemptId, said: String(input.raw ?? "").slice(0, 300) },
    },
    // No contact permission and no outreach: a recruiter calls the friend.
    { orgId: referrer.orgId, campaignId: referrer.campaignId, isDemo: referrer.isDemo, actorId: null, scheduleOutreach: false },
  );
  if (!("leadId" in r)) return { ok: false, say: "Ask the driver to say their friend's number again, digit by digit." };
  const friend = await db.lead.findUniqueOrThrow({ where: { id: r.leadId } });
  if (r.result === "created") {
    await db.task.upsert({
      where: { dedupeKey: `REFERRAL:${friend.id}` },
      create: { leadId: friend.id, type: "CALLBACK", title: `Referred by ${referrerName}: call this driver`, assignedToId: friend.assignedToId, notes: `${referrerName} (${referrer.phoneE164}) gave this number on a call with Crystal. Mention their name when you call.`, dedupeKey: `REFERRAL:${friend.id}` },
      update: {},
    });
  }
  await recordEvent({ leadId: friend.id, actorType: "AI", type: "REFERRAL", message: `Referred by ${referrerName} (${referrer.phoneE164}) on a call${r.result === "created" ? "" : "; already in our list"}` });
  await recordEvent({ leadId: referrer.id, actorType: "DRIVER", type: "REFERRAL", message: `Referred a driver: ${name || "no name"} (${phone})` });
  return { ok: true, leadId: friend.id, say: "Saved. Thank the driver warmly and ask if they know anyone else; if not, go on to the goodbye." };
}

/** The friends a driver referred, for the recruiter's card. */
export async function referralsOf(referrerLeadId: string) {
  const recs = await db.leadSourceRecord.findMany({
    where: { sourceSystem: REFERRAL_SOURCE, sourceRecordId: { startsWith: referralPrefix(referrerLeadId) } },
    orderBy: { createdAt: "asc" },
    select: { lead: { select: { id: true, firstName: true, lastName: true, phoneE164: true } } },
  });
  return recs.map((x) => x.lead);
}

/** Who referred this lead, if a driver did. */
export async function referrerOf(leadId: string) {
  const rec = await db.leadSourceRecord.findFirst({ where: { leadId, sourceSystem: REFERRAL_SOURCE }, orderBy: { createdAt: "asc" }, select: { raw: true } });
  const raw = (rec?.raw ?? null) as { referredBy?: string; referrerName?: string; referrerPhone?: string } | null;
  return raw?.referredBy ? { leadId: raw.referredBy, name: raw.referrerName ?? "", phone: raw.referrerPhone ?? "" } : null;
}
