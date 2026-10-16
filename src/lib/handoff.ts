import type { HandoffReason, Prisma, TransferStatus } from "@prisma/client";
import { db, Tx } from "./db";
import { recordEvent } from "./activity";
import { ensureAssigned } from "./assignment";
import { advancePipeline } from "./leads";
import { DEFAULT_SLOTS } from "./conversation/brain";
import { formatLocal } from "./timezone";
import { getSettings } from "./settings";

export async function essentialSlotKeys(): Promise<string[]> {
  const s = await getSettings();
  const cfg = (s.screeningConfig as { key: string; enabled: boolean; essential: boolean }[] | null) ?? DEFAULT_SLOTS;
  return cfg.filter((x) => x.enabled && x.essential).map((x) => x.key);
}

/** Everything the human recruiter needs, frozen at handoff time. */
export async function buildHandoffPayload(leadId: string, tx: Tx | typeof db = db) {
  const lead = await tx.lead.findUniqueOrThrow({
    where: { id: leadId },
    include: {
      screening: true, documents: { where: { deletedAt: null } }, questions: true,
      calls: { orderBy: { createdAt: "desc" }, take: 1 }, assignedTo: true,
    },
  });
  const lastCall = lead.calls[0];
  const offerVersion = lead.lastOfferVersionId ? await tx.offerVersion.findUnique({ where: { id: lead.lastOfferVersionId }, include: { offer: true } }) : null;
  const interest = lead.screening.find((s) => s.key === "offer_interest")?.reportedValue ?? null;
  return {
    driver: {
      name: [lead.firstName, lead.lastName].filter(Boolean).join(" ") || null,
      phone: lead.phoneE164, email: lead.email, state: lead.state, zip: lead.zip, timezone: lead.timezone,
    },
    driverReported: lead.screening.map((s) => ({ key: s.key, value: s.reportedValue, status: s.status, verified: s.verifiedValue ?? null })),
    note: "Driver-reported values are unverified. Official verification (MVR, PSP/PEV, Clearinghouse, license validity) has NOT been performed by this system.",
    offer: offerVersion ? { name: offerVersion.offer.name, version: offerVersion.version, versionId: offerVersion.id, synthetic: offerVersion.synthetic } : null,
    interest,
    concerns: lead.screening.find((s) => s.key === "concerns")?.reportedValue ?? null,
    unansweredQuestions: lead.questions.filter((q) => q.status === "OPEN").map((q) => q.question),
    documents: { status: lead.documentStatus, links: lead.documents.map((d) => ({ id: d.id, url: `/api/documents/${d.id}`, uploadedAt: d.uploadedAt })) },
    lastCall: lastCall ? { id: lastCall.id, outcome: lastCall.outcome, summary: lastCall.summary, transcriptUrl: `/leads/${lead.id}#call-${lastCall.id}` } : null,
    nextAction: lead.callbackAt
      ? { type: "CALLBACK", at: lead.callbackAt.toISOString(), driverLocal: formatLocal(lead.callbackAt, lead.timezone) }
      : { type: "RECRUITER_FOLLOW_UP", at: null, driverLocal: null },
  };
}

export async function createHandoff(
  leadId: string,
  reason: HandoffReason,
  opts: { callAttemptId?: string | null; transferStatus?: TransferStatus; note?: string } = {},
) {
  return db.$transaction(async (tx) => {
    const recruiterId = await ensureAssigned(leadId, tx);
    const payload = await buildHandoffPayload(leadId, tx);
    const handoff = await tx.handoff.create({
      data: {
        leadId, reason, recruiterId, callAttemptId: opts.callAttemptId ?? null,
        transferStatus: opts.transferStatus ?? "NOT_ATTEMPTED",
        payload: { ...payload, note: opts.note ? `${payload.note} ${opts.note}` : payload.note } as Prisma.InputJsonValue,
      },
    });
    const titles: Record<HandoffReason, string> = {
      READY: "Candidate ready: review CDL and screening",
      HUMAN_REQUESTED: "Driver asked to speak with a recruiter",
      UNKNOWN_QUESTION: "Driver question needs an answer",
      ELIGIBILITY_EXCEPTION: "Possible eligibility exception: review personally",
      TECHNICAL: "Technical problem during AI call",
    };
    await tx.task.upsert({
      where: { dedupeKey: `handoff:${leadId}:${reason}:${opts.callAttemptId ?? "none"}` },
      create: { leadId, type: "HANDOFF", assignedToId: recruiterId, title: titles[reason], notes: opts.note, dedupeKey: `handoff:${leadId}:${reason}:${opts.callAttemptId ?? "none"}`, dueAt: new Date() },
      update: {},
    });
    if (reason === "READY") await advancePipeline(leadId, "HANDED_OFF", tx);
    await recordEvent({ leadId, actorType: "SYSTEM", type: "HANDOFF", message: `Handed to human recruiter (${reason.replace(/_/g, " ").toLowerCase()})`, data: { handoffId: handoff.id, recruiterId } }, tx);
    return handoff;
  });
}

/** Normal readiness: interested + essentials collected + CDL received. */
export async function evaluateHandoffReadiness(leadId: string) {
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, include: { screening: true, handoffs: true } });
  if (lead.handoffs.some((h) => h.reason === "READY")) return { ready: true, created: false };
  const interested = lead.screening.find((s) => s.key === "offer_interest")?.reportedValue === "Interested";
  const essentials = await essentialSlotKeys();
  const missing = essentials.filter((k) => {
    if (k === "home_location" && (lead.state || lead.zip)) return false; // already known from the lead source
    return !lead.screening.some((s) => s.key === k && s.reportedValue && s.status !== "UNCLEAR");
  });
  // With CDL texting off, the recruiter collects the CDL, so it is not required before handoff.
  const docs = lead.documentStatus === "RECEIVED" || !(await getSettings()).cdlBySms;
  if (!interested || missing.length || !docs) return { ready: false, missing, interested, docs };
  await advancePipeline(leadId, "HANDOFF_READY");
  await createHandoff(leadId, "READY");
  return { ready: true, created: true };
}
