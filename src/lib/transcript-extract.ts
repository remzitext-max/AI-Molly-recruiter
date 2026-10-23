// Fills the driver's screening answers from the call transcript when the live
// agent heard them but did not save them with record_screening_answer.
// Uses Telnyx's OpenAI-compatible inference endpoint with the same API key.
import type { Prisma } from "@prisma/client";
import { config } from "./config";
import { db } from "./db";
import { providerFetch } from "../adapters/live/http";
import { redactText } from "./redact";
import { recordEvent } from "./activity";
import { advancePipeline } from "./leads";
import { enqueue } from "./jobs/queue";

const URL_ = "https://api.telnyx.com/v2/ai/openai/chat/completions";

// key -> what to extract, in the words the recruiter card uses.
const FIELDS: Record<string, string> = {
  first_name: "driver's first name if they corrected it",
  home_location: "where the driver is based (city/state or state)",
  cdl_class: "CDL class, e.g. A",
  experience_years: "OTR / CDL driving experience, e.g. 3 years",
  weekly_miles: "miles the driver says they can cover, in their words with the unit, e.g. 4,000 a week or 600 a day",
  sap_history: "SAP program history (yes/no and details)",
  accidents_at_fault: "accidents at fault (yes/no and details)",
  home_time: "home-time option the driver picked or asked for, e.g. 5 weeks out / 6 days home",
  start_date: "when the driver can start, e.g. ASAP or a date",
  med_card_expiry: "DOT medical card expiry as the driver said it",
  driving_type: "solo or team, only if the driver said",
  endorsements: "endorsements, only if mentioned",
  equipment_experience: "equipment experience, only if the driver mentioned it",
  english_level: "your rating of the driver's spoken English from their lines: Good, Fair or Poor",
  concerns: "any concern or question the driver raised, short",
};

// Always asked: whether the driver said yes or no, for calls that ended before the
// agent recorded an outcome (e.g. the driver hung up after saying no).
const RESULT_KEYS: Record<string, string> = {
  call_result: "the driver's decision in this call, one of: interested, not_interested, call_later, unclear",
  decline_reason: "if not_interested: why, short, in the driver's words",
  unanswered: "screening questions (experience, location, CDL class, SAP, accidents, home time, miles, start date, medical card) the driver did not answer or answered unclearly, including ones never reached because the call ended; short names, comma separated",
  call_summary: "notes for the recruiter in English: one or two sentences on how the call went, then 3 to 6 short lines each starting with '• ' recapping what the driver said (experience, location, home time, miles, start, concerns, decision). Say 'unclear' where the driver's answer was unclear. Under 700 characters",
};

/** What the transcript reader concluded about one call, kept on CallAttempt.metrics.callNotes for the Telegram card. */
export type CallNotes = { result?: string; reason?: string; unanswered?: string };

type Turn = { speaker: string; text: string };

/** The JSON object from the model's reply, keeping only known keys with non-empty string values. Exported for tests. */
export function parseAnswers(content: string): Record<string, string> {
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return {};
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(m[0]); } catch { return {}; }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if ((k in FIELDS || k in RESULT_KEYS) && typeof v === "string" && v.trim() && !/^(unknown|n\/a|none|null)$/i.test(v.trim())) out[k] = v.trim().slice(0, k === "call_summary" ? 900 : 200);
  }
  return out;
}

/** Saves answers the agent missed. Never overwrites an answer the agent saved itself. Returns the keys filled. */
export async function fillScreeningFromTranscript(attemptId: string): Promise<string[]> {
  const a = await db.callAttempt.findUnique({ where: { id: attemptId }, include: { lead: { include: { screening: true } } } });
  const turns = (Array.isArray(a?.transcript) ? a!.transcript : []) as Turn[];
  if (!a || !config.telnyx.apiKey || !turns.some((t) => t.speaker === "driver")) return [];
  const have = new Set(a.lead.screening.filter((f) => f.reportedValue).map((f) => f.key));
  const wanted = Object.keys(FIELDS).filter((k) => !have.has(k));
  const asked = [...wanted.map((k) => `- ${k}: ${FIELDS[k]}`), ...Object.entries(RESULT_KEYS).map(([k, d]) => `- ${k}: ${d}`)];

  const text = turns.map((t) => `${t.speaker === "driver" ? "Driver" : "Recruiter"}: ${t.text.replace(/<[^>]+>/g, "")}`).join("\n").slice(0, 20_000);
  const messages = [
    { role: "system", content: "You read a phone call between a trucking recruiter and a truck driver and return ONLY a JSON object, no other text. Include a key only when the DRIVER actually gave that answer in the call; never guess, never copy what the recruiter offered. Use the driver's own words, short." },
    { role: "user", content: `Keys:\n${asked.join("\n")}\n\nCall:\n${text}` },
  ];
  const ask = async (strict: boolean) => {
    const res = await providerFetch(URL_, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.telnyx.apiKey}`, "Content-Type": "application/json" },
      timeoutMs: 90_000,
      body: JSON.stringify({
        model: process.env.TELNYX_EXTRACT_MODEL || "moonshotai/Kimi-K2.6",
        temperature: 0, max_tokens: 1500, enable_thinking: false, messages,
        ...(strict ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    return body.choices?.[0]?.message?.content ?? "";
  };
  let content: string;
  try {
    // Some models reject response_format; ask again in plain mode before giving up.
    content = await ask(true).catch(() => ask(false));
  } catch (e) {
    await recordEvent({ leadId: a.leadId, actorType: "SYSTEM", type: "TRANSCRIPT_ANSWERS", message: `Could not read answers from the call text: ${redactText((e as Error).message).slice(0, 300)}` });
    throw e;
  }
  const answers = parseAnswers(content);
  const filled: string[] = [];
  for (const k of wanted) {
    const v = answers[k];
    if (!v) continue;
    await db.screeningField.upsert({
      where: { leadId_key: { leadId: a.leadId, key: k } },
      create: { leadId: a.leadId, key: k, reportedValue: redactText(v), rawUtterance: "(from call transcript)", status: "CAPTURED", callAttemptId: a.id },
      update: { reportedValue: redactText(v), rawUtterance: "(from call transcript)", status: "CAPTURED", callAttemptId: a.id },
    });
    filled.push(k);
  }
  const result = (answers.call_result ?? "").toLowerCase().replace(/[^a-z_]/g, "");
  const notes: CallNotes = {
    result: result || undefined,
    reason: answers.decline_reason ? redactText(answers.decline_reason) : undefined,
    unanswered: answers.unanswered ? redactText(answers.unanswered) : undefined,
  };
  await db.callAttempt.update({ where: { id: a.id }, data: {
    metrics: { ...((a.metrics as Record<string, unknown> | null) ?? {}), callNotes: notes } as Prisma.InputJsonValue,
    summary: answers.call_summary && !a.summary ? redactText(answers.call_summary) : undefined,
  } });
  await recordEvent({ leadId: a.leadId, actorType: "SYSTEM", type: "TRANSCRIPT_ANSWERS", message: filled.length ? `Answers read from the call text: ${filled.join(", ")}` : "No new answers found in the call text" });
  if (a.outcome === "INCOMPLETE") await settleUnfinishedCall(a.id, a.leadId, answers.call_result, answers.decline_reason);
  return filled;
}

/**
 * The driver answered and decided, but the call ended (often the driver hanging up)
 * before the agent recorded it. Without this the lead stays queued and gets the
 * whole pitch again hours later. A clear yes goes to the recruiter, a clear no stops
 * the AI calls (the 30-day follow-up still applies); anything else keeps the retry.
 */
async function settleUnfinishedCall(attemptId: string, leadId: string, result?: string, reason?: string) {
  const r = (result ?? "").toLowerCase().replace(/[^a-z_]/g, "");
  if (r !== "interested" && r !== "not_interested") return;
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { pipelineStatus: true } });
  if (!lead || !["NEW", "QUEUED", "CONTACTING"].includes(lead.pipelineStatus)) return;
  await db.$executeRaw`UPDATE "Job" SET status = 'CANCELED', "updatedAt" = now() WHERE status = 'PENDING' AND type = 'lead.attempt-call' AND payload->>'leadId' = ${leadId}`;
  if (r === "not_interested") {
    const why = reason ? `: ${redactText(reason).slice(0, 150)}` : "";
    await db.lead.update({ where: { id: leadId }, data: { nextContactAt: null, queueReason: `Driver said no in the call${why}` } });
    await advancePipeline(leadId, "NOT_INTERESTED");
    await recordEvent({ leadId, actorType: "SYSTEM", type: "CALL_RESULT", message: `Driver said no in the call${why}. No more AI calls (call ended before the agent saved it).` });
  } else {
    await db.lead.update({ where: { id: leadId }, data: { nextContactAt: null, queueReason: "Interested in the call: for the recruiter" } });
    await advancePipeline(leadId, "INTERESTED");
    await enqueue("handoff.evaluate", { leadId }, { idempotencyKey: `handoff-eval:call:${attemptId}` });
    await recordEvent({ leadId, actorType: "SYSTEM", type: "CALL_RESULT", message: "Driver was interested in the call; no repeat AI call, handed to the recruiter (call ended before the agent saved it)." });
  }
}
