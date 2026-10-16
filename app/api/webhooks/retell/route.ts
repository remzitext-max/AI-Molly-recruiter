import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { verifyRetellSignature } from "@/adapters/live/retell";
import { ingestVoiceEvent } from "@/lib/calls";
import { mapRetellWebhook } from "@/lib/retell-mapping";
import { log } from "@/lib/redact";

export async function POST(req: Request) {
  const raw = await req.text();
  const key = config.retell.apiKey;
  if (!key || !verifyRetellSignature(raw, req.headers.get("x-retell-signature"), key)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const ev = mapRetellWebhook(body as Parameters<typeof mapRetellWebhook>[0]);
  if (!ev) return NextResponse.json({ ignored: true });
  try {
    const r = await ingestVoiceEvent(ev);
    return NextResponse.json(r);
  } catch (e) {
    log.error("retell webhook failed", { error: (e as Error).message });
    return NextResponse.json({ error: "retry" }, { status: 500 });
  }
}
