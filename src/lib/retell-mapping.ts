// Maps documented Retell webhook payloads to our provider-neutral VoiceEvent.
import type { CallOutcome, CallStatus } from "@prisma/client";
import type { VoiceEvent } from "./calls";

interface RetellCall {
  call_id: string; call_status?: string; disconnection_reason?: string; end_timestamp?: number; start_timestamp?: number;
  metadata?: { attempt_id?: string }; transcript_object?: { role: string; content: string }[];
  call_analysis?: { call_summary?: string; custom_analysis_data?: { outcome?: string } };
}

const OUTCOMES = new Set(["INTERESTED", "NOT_INTERESTED", "CALLBACK", "OPT_OUT", "HUMAN_REQUESTED", "VOICEMAIL_LEFT", "NO_CONTACT", "WRONG_NUMBER", "INCOMPLETE", "TECHNICAL_FAILURE"]);

export function mapRetellWebhook(body: { event: string; call: RetellCall }): VoiceEvent | null {
  const c = body.call;
  if (!c?.call_id) return null;
  const base = { provider: "retell", providerCallId: c.call_id, attemptId: c.metadata?.attempt_id, eventId: `${body.event}:${c.call_id}` };
  switch (body.event) {
    case "call_started":
      return { ...base, type: "call_answered", occurredAt: c.start_timestamp ? new Date(c.start_timestamp).toISOString() : undefined };
    case "call_ended":
    case "call_analyzed": {
      const r = c.disconnection_reason ?? "";
      let status: CallStatus = "COMPLETED";
      if (r === "voicemail_reached") status = "VOICEMAIL";
      else if (r === "dial_no_answer") status = "NO_ANSWER";
      else if (r === "dial_busy") status = "BUSY";
      else if (r === "dial_failed" || r.startsWith("error")) status = "FAILED";
      const o = c.call_analysis?.custom_analysis_data?.outcome?.toUpperCase();
      return {
        ...base, type: "call_ended", status,
        outcome: o && OUTCOMES.has(o) ? (o as CallOutcome) : undefined,
        summary: c.call_analysis?.call_summary,
        transcript: c.transcript_object?.map((t) => ({ speaker: t.role === "agent" ? "agent" : "driver", text: t.content })),
        occurredAt: c.end_timestamp ? new Date(c.end_timestamp).toISOString() : undefined,
        metrics: { disconnection_reason: r },
      };
    }
    case "transfer_bridged":
      return { ...base, type: "transfer_succeeded" };
    case "transfer_cancelled":
      return { ...base, type: "transfer_failed" };
    case "transfer_started":
      return { ...base, type: "transfer_started" };
    default:
      return null;
  }
}
