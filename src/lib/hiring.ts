// Hiring result for a lead, set by a recruiter after the hand-off. Crystal never
// sets it. It is what turns "interested drivers" into lead-to-hire and cost per hire.
import type { HireStage } from "@prisma/client";
import { db } from "./db";
import { recordEvent } from "./activity";
import { enqueue } from "./jobs/queue";
import { telegramConfigured } from "./telegram";
import { queueMetaStageEvent } from "./meta";

export const HIRE_STAGES: HireStage[] = ["NONE", "APPLICATION", "ORIENTATION", "HIRED", "NOT_HIRED"];
export const HIRE_LABEL: Record<HireStage, string> = {
  NONE: "Not set",
  APPLICATION: "Application in",
  ORIENTATION: "Orientation booked",
  HIRED: "Hired",
  NOT_HIRED: "Not hired",
};

export async function setHireStage(leadId: string, stage: HireStage, note: string | null, actor: { id: string; name: string }, now = new Date()) {
  if (!HIRE_STAGES.includes(stage)) throw new Error("Unknown hiring stage");
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
  const cleanNote = note?.trim().slice(0, 500) || null;
  if (lead.hireStage === stage && (lead.hireNote ?? null) === cleanNote) return { changed: false };
  await db.$transaction(async (tx) => {
    await tx.lead.update({
      where: { id: leadId },
      data: {
        hireStage: stage,
        hireStageAt: stage === lead.hireStage ? lead.hireStageAt : now,
        hiredAt: stage === "HIRED" ? lead.hiredAt ?? now : null,
        hireNote: cleanNote,
      },
    });
    await recordEvent({ leadId, actorType: "USER", actorId: actor.id, type: "HIRE_STAGE", message: `Hiring: ${HIRE_LABEL[lead.hireStage]} → ${HIRE_LABEL[stage]} (by ${actor.name})${cleanNote ? `: ${cleanNote}` : ""}` }, tx);
    if (stage === "HIRED" && lead.hireStage !== "HIRED") {
      await queueMetaStageEvent(leadId, "HIRED", tx);
      if (telegramConfigured() && !lead.isDemo) await enqueue("notify.telegram-hired", { leadId, by: actor.name }, { idempotencyKey: `telegram-hired:${leadId}`, maxAttempts: 3 }, tx);
    }
  });
  return { changed: true };
}
