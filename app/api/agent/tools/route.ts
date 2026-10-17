import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { verifyRetellSignature } from "@/adapters/live/retell";
import { findToolAttempt, runAgentTool, UNKNOWN_CALL } from "@/lib/agent-tools";

// Restricted tool endpoint for the Retell voice agent. Only the named tools
// exist; arguments are validated by applyAgentAction's closed schema.
export async function POST(req: Request) {
  const raw = await req.text();
  const key = config.retell.apiKey;
  if (!key || !verifyRetellSignature(raw, req.headers.get("x-retell-signature"), key)) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  const body = JSON.parse(raw) as { name?: string; call?: { call_id?: string; metadata?: { attempt_id?: string } }; args?: Record<string, unknown> };
  const attempt = await findToolAttempt({ providerCallId: body.call?.call_id, attemptId: body.call?.metadata?.attempt_id });
  if (!attempt) return NextResponse.json(UNKNOWN_CALL);
  const result = await runAgentTool(attempt, body.name, body.args ?? {});
  return result ? NextResponse.json(result) : NextResponse.json({ error: "unknown tool" }, { status: 400 });
}
