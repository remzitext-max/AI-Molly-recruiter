import { NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { verifySignature } from "@/lib/webhook-auth";
import { ingestVoiceEvent } from "@/lib/calls";

// Provider-neutral signed event endpoint (used for testing and by any adapter
// that forwards normalized events). Signature: x-molly-signature.
const Ev = z.object({
  provider: z.string().max(40), eventId: z.string().min(1).max(200),
  type: z.enum(["call_started", "call_ringing", "call_answered", "call_ended", "transfer_started", "transfer_succeeded", "transfer_failed"]),
  providerCallId: z.string().max(200).optional(), attemptId: z.string().max(60).optional(),
  status: z.enum(["SCHEDULED", "DIALING", "RINGING", "IN_PROGRESS", "COMPLETED", "NO_ANSWER", "BUSY", "VOICEMAIL", "FAILED", "UNKNOWN", "CANCELED"]).optional(),
  summary: z.string().max(4000).optional(), occurredAt: z.string().datetime().optional(),
});

export async function POST(req: Request) {
  const raw = await req.text();
  const v = verifySignature(config.webhookSecret, raw, req.headers.get("x-molly-signature"));
  if (!v.ok) return NextResponse.json({ error: v.reason }, { status: 401 });
  const parsed = Ev.safeParse(JSON.parse(raw));
  if (!parsed.success) return NextResponse.json({ error: "invalid event" }, { status: 400 });
  try {
    return NextResponse.json(await ingestVoiceEvent(parsed.data));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
