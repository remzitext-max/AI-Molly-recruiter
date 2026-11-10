import { NextResponse } from "next/server";
import { telnyxTokenOk } from "@/adapters/live/telnyx";
import { inboundInit } from "@/lib/inbound";
import { log } from "@/lib/redact";

// Telnyx dynamic-variables webhook: called when a call to or from the assistant starts.
// Inbound calls get the caller's lead variables; our own outbound calls get {}.
export async function POST(req: Request) {
  const url = new URL(req.url);
  if (!telnyxTokenOk(url.searchParams.get("token"))) return NextResponse.json({ error: "invalid token" }, { status: 401 });
  let body: unknown = {};
  try { body = await req.json(); } catch { /* empty */ }
  try {
    return NextResponse.json(await inboundInit(body));
  } catch (e) {
    log.error("telnyx init failed", { error: (e as Error).message });
    return NextResponse.json({});
  }
}
