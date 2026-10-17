import { NextResponse } from "next/server";
import { telnyxTokenOk } from "@/adapters/live/telnyx";
import { findToolAttempt, runAgentTool, UNKNOWN_CALL } from "@/lib/agent-tools";

// Tool endpoint for the Telnyx AI assistant. The assistant's webhook tools send
// token, tool and attempt_id as preset query parameters the model never sees;
// the JSON body holds the model's arguments.
export async function POST(req: Request) {
  const url = new URL(req.url);
  if (!telnyxTokenOk(url.searchParams.get("token"))) return NextResponse.json({ error: "invalid token" }, { status: 401 });
  let args: Record<string, unknown> = {};
  try { args = (await req.json()) as Record<string, unknown>; } catch { /* tools without arguments send no body */ }
  const attempt = await findToolAttempt({ attemptId: url.searchParams.get("attempt_id") ?? undefined });
  if (!attempt) return NextResponse.json(UNKNOWN_CALL);
  const result = await runAgentTool(attempt, url.searchParams.get("tool") ?? undefined, args);
  return result ? NextResponse.json(result) : NextResponse.json({ error: "unknown tool" }, { status: 400 });
}
