// Maps Telnyx TeXML status callbacks and AI conversation callbacks to our
// provider-neutral VoiceEvent. TeXML callbacks use Twilio-style form fields
// (CallSid, CallStatus, AnsweredBy); the parser also accepts JSON bodies.
import type { CallStatus } from "@prisma/client";
import type { VoiceEvent } from "./calls";

type Flat = Record<string, unknown>;

export function parseTelnyxBody(raw: string, contentType: string | null): Flat {
  if ((contentType ?? "").includes("json") || raw.trim().startsWith("{")) {
    try { return JSON.parse(raw) as Flat; } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

const END_STATUS: Record<string, CallStatus> = { completed: "COMPLETED", "no-answer": "NO_ANSWER", busy: "BUSY", canceled: "FAILED", failed: "FAILED" };

export function mapTelnyxCallback(body: Flat, attemptId: string | undefined): VoiceEvent | null {
  // AI conversation callback (JSON): carries the transcript once the conversation ends.
  const data = (body.data as Flat | undefined) ?? body;
  const eventType = String(data.event_type ?? body.event_type ?? body.EventType ?? "");
  if (eventType.includes("conversation")) {
    if (!eventType.includes("ended")) return null;
    const p = (data.payload as Flat | undefined) ?? data;
    const messages = (p.messages as { role?: string; content?: string; timestamp?: string }[] | undefined) ?? [];
    const transcript = messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
      .map((m) => ({ speaker: m.role === "assistant" ? "agent" : "driver", text: String(m.content), at: m.timestamp }));
    const id = String(p.conversation_id ?? p.call_control_id ?? data.id ?? "");
    return { provider: "telnyx", eventId: `conversation_ended:${id || attemptId}`, type: "call_ended", attemptId, transcript: transcript.length ? transcript : undefined, metrics: { reason: p.reason ?? null } };
  }

  const sid = String(body.CallSid ?? body.call_sid ?? "");
  const st = String(body.CallStatus ?? body.call_status ?? "").toLowerCase();
  if (!sid || !st) return null;
  const base = { provider: "telnyx", providerCallId: sid, attemptId, eventId: `${st}:${sid}` };
  if (st === "initiated" || st === "queued") return { ...base, type: "call_started" };
  if (st === "ringing") return { ...base, type: "call_ringing" };
  if (st === "answered" || st === "in-progress") return { ...base, type: "call_answered" };
  const end = END_STATUS[st];
  if (!end) return null;
  const answeredBy = String(body.AnsweredBy ?? "").toLowerCase();
  const status: CallStatus = end === "COMPLETED" && answeredBy.startsWith("machine") ? "VOICEMAIL" : end;
  return { ...base, type: "call_ended", status, metrics: {
    call_status: st, answered_by: answeredBy || null, duration_sec: body.CallDuration ?? null,
    // Who hung up, when Telnyx sends it (field names vary between callback formats).
    hangup_source: body.HangupSource ?? body.hangup_source ?? null, hangup_cause: body.HangupCause ?? body.hangup_cause ?? null,
  } };
}
