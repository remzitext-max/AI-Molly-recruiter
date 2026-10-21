// Who ended an answered call: Crystal (her hangup tool), the driver, or a voicemail.
// Uses the provider's hangup fields when Telnyx sends them, else the transcript:
// Crystal's hang-ups show up there as a "[hangup]" tool note on her last turn.

export type EndedBy = "agent" | "driver" | "voicemail";

type CallLike = { status: string; transcript?: unknown; metrics?: unknown };

export function whoEnded(c: CallLike): EndedBy | null {
  if (c.status === "VOICEMAIL") return "voicemail";
  if (c.status !== "COMPLETED") return null;
  const m = (c.metrics && typeof c.metrics === "object" ? c.metrics : {}) as Record<string, unknown>;
  // Outbound call: we are the caller, the driver is the callee.
  const src = String(m.hangup_source ?? "").toLowerCase();
  if (src === "callee") return "driver";
  if (src === "caller") return "agent";
  const reason = String(m.reason ?? "").toLowerCase();
  if (/assistant|agent|bot|tool/.test(reason)) return "agent";
  if (/user|customer|callee|remote/.test(reason)) return "driver";
  if (!Array.isArray(c.transcript) || !c.transcript.length) return null;
  const turns = c.transcript as { speaker?: string; text?: string }[];
  return turns.some((t) => t.speaker === "agent" && /\[[^\]]*\bhangup\b/i.test(t.text ?? "")) ? "agent" : "driver";
}

export function endedByText(by: EndedBy | null, agentName: string) {
  return by === "agent" ? `${agentName} ended the call` : by === "driver" ? "Driver hung up" : by === "voicemail" ? "Voicemail" : null;
}
