import { db, Tx } from "./db";
import { redactDeep, redactText } from "./redact";

export type ActorType = "USER" | "AI" | "SYSTEM" | "PROVIDER" | "DRIVER";

/** Append an audit/timeline event. Data is redacted before storage. */
export async function recordEvent(
  e: { leadId?: string | null; orgId?: string | null; actorType: ActorType; actorId?: string | null; type: string; message: string; data?: unknown },
  tx: Tx | typeof db = db,
) {
  return tx.activityEvent.create({
    data: {
      leadId: e.leadId ?? null,
      orgId: e.orgId ?? null,
      actorType: e.actorType,
      actorId: e.actorId ?? null,
      type: e.type,
      message: redactText(e.message),
      data: e.data === undefined ? undefined : (redactDeep(e.data) as object),
    },
  });
}
