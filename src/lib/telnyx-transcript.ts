// Fetches the transcript of a finished Telnyx AI Assistant call from the
// Conversations API (GET /v2/ai/conversations, GET /v2/ai/conversations/{id}/messages)
// when the conversation callback did not deliver one.
import { config } from "./config";
import { db } from "./db";
import { providerFetch } from "../adapters/live/http";
import { redactText } from "./redact";
import type { Prisma } from "@prisma/client";

const BASE = "https://api.telnyx.com/v2";

type Msg = { role: string; text: string | null; created_at?: string; sent_at?: string; tool_calls?: { function?: { name?: string; arguments?: string | Record<string, unknown> } }[] };

/** Conversation messages -> our transcript turns (driver/agent only, in time order). Exported for tests. */
export function toTurns(msgs: Msg[]) {
  // Tool calls are kept as a short note (e.g. "[hangup]") so it is clear who ended a call;
  // a transfer keeps the target it dialed ("[transfer: Dennis]").
  const note = (f?: { name?: string; arguments?: string | Record<string, unknown> }) => {
    if (!f?.name) return null;
    let args: Record<string, unknown> = {};
    try { args = typeof f.arguments === "string" ? JSON.parse(f.arguments) : f.arguments ?? {}; } catch { /* not JSON */ }
    const target = f.name === "transfer" ? args.target ?? args.to ?? args.name : null;
    return typeof target === "string" && target ? `${f.name}: ${target}` : f.name;
  };
  const text = (m: Msg) => {
    const tools = m.role === "assistant" ? (m.tool_calls ?? []).map((t) => note(t.function)).filter(Boolean) : [];
    return [m.text?.trim(), tools.length ? `[${tools.join(", ")}]` : ""].filter(Boolean).join(" ");
  };
  return msgs
    .filter((m) => (m.role === "user" || m.role === "assistant") && text(m))
    .sort((a, b) => Date.parse(a.sent_at ?? a.created_at ?? "") - Date.parse(b.sent_at ?? b.created_at ?? ""))
    .map((m) => ({ speaker: m.role === "user" ? "driver" : "agent", text: redactText(text(m)), at: m.sent_at ?? m.created_at }));
}

/** Saves the transcript on the call attempt. Throws when the conversation is not there yet, so the job retries. */
export async function fetchTelnyxTranscript(attemptId: string) {
  const a = await db.callAttempt.findUnique({ where: { id: attemptId }, include: { lead: true } });
  if (!a || a.provider !== "telnyx" || !a.startedAt || Array.isArray(a.transcript)) return { saved: false };
  const { apiKey, assistantId } = config.telnyx;
  if (!apiKey || !assistantId) return { saved: false };
  const headers = { Authorization: `Bearer ${apiKey}` };
  const since = new Date(a.startedAt.getTime() - 2 * 60_000).toISOString();
  const q = new URLSearchParams({ "metadata->assistant_id": `eq.${assistantId}`, "metadata->telnyx_end_user_target": `eq.${a.lead.phoneE164}`, created_at: `gte.${since}`, order: "created_at.asc", limit: "1" });
  const list = (await (await providerFetch(`${BASE}/ai/conversations?${q}`, { headers })).json()) as { data?: { id: string }[] };
  const conv = list.data?.[0];
  if (!conv) throw new Error("Telnyx conversation not found yet");
  const msgs = (await (await providerFetch(`${BASE}/ai/conversations/${encodeURIComponent(conv.id)}/messages?page[size]=100`, { headers })).json()) as { data?: Msg[] };
  const turns = toTurns(msgs.data ?? []);
  await db.callAttempt.update({ where: { id: a.id }, data: { transcript: turns as Prisma.InputJsonValue } });
  return { saved: true, turns: turns.length };
}
