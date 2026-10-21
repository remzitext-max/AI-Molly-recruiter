import { NextResponse } from "next/server";
import { telnyxTokenOk } from "@/adapters/live/telnyx";
import { ingestVoiceEvent } from "@/lib/calls";
import { mapTelnyxCallback, parseTelnyxBody } from "@/lib/telnyx-mapping";
import { log } from "@/lib/redact";
import { enqueue } from "@/lib/jobs/queue";

// TeXML status and AI conversation callbacks for calls placed by TelnyxVoiceAgent.
// The callback URL carries our shared token and the attempt ID.
export async function POST(req: Request) {
  const url = new URL(req.url);
  if (!telnyxTokenOk(url.searchParams.get("token"))) return NextResponse.json({ error: "invalid token" }, { status: 401 });
  const body = parseTelnyxBody(await req.text(), req.headers.get("content-type"));
  const attemptId = url.searchParams.get("attempt_id") ?? undefined;
  if (url.searchParams.get("recording") === "1") {
    // Recording status callback: download it in a job (the link is short-lived).
    const recUrl = String(body.RecordingUrl ?? body.PublicRecordingUrl ?? "");
    if (!attemptId || !recUrl || String(body.RecordingStatus ?? "completed") !== "completed") return NextResponse.json({ ignored: true });
    await enqueue("call.fetch-recording", { attemptId, url: recUrl }, { idempotencyKey: `recording:${attemptId}`, maxAttempts: 4 });
    return NextResponse.json({ ok: true });
  }
  const ev = mapTelnyxCallback(body, attemptId);
  if (!ev) return NextResponse.json({ ignored: true });
  try {
    return NextResponse.json(await ingestVoiceEvent(ev));
  } catch (e) {
    log.error("telnyx webhook failed", { error: (e as Error).message });
    return NextResponse.json({ error: "retry" }, { status: 500 });
  }
}
