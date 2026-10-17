import { NextResponse } from "next/server";
import { telnyxTokenOk } from "@/adapters/live/telnyx";
import { ingestVoiceEvent } from "@/lib/calls";
import { mapTelnyxCallback, parseTelnyxBody } from "@/lib/telnyx-mapping";
import { log } from "@/lib/redact";

// TeXML status and AI conversation callbacks for calls placed by TelnyxVoiceAgent.
// The callback URL carries our shared token and the attempt ID.
export async function POST(req: Request) {
  const url = new URL(req.url);
  if (!telnyxTokenOk(url.searchParams.get("token"))) return NextResponse.json({ error: "invalid token" }, { status: 401 });
  const ev = mapTelnyxCallback(parseTelnyxBody(await req.text(), req.headers.get("content-type")), url.searchParams.get("attempt_id") ?? undefined);
  if (!ev) return NextResponse.json({ ignored: true });
  try {
    return NextResponse.json(await ingestVoiceEvent(ev));
  } catch (e) {
    log.error("telnyx webhook failed", { error: (e as Error).message });
    return NextResponse.json({ error: "retry" }, { status: 500 });
  }
}
