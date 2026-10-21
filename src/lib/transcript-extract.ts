// Fills the driver's screening answers from the call transcript when the live
// agent heard them but did not save them with record_screening_answer.
// Uses Telnyx's OpenAI-compatible inference endpoint with the same API key.
import { config } from "./config";
import { db } from "./db";
import { providerFetch } from "../adapters/live/http";
import { redactText } from "./redact";
import { recordEvent } from "./activity";

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

type Turn = { speaker: string; text: string };

/** The JSON object from the model's reply, keeping only known keys with non-empty string values. Exported for tests. */
export function parseAnswers(content: string): Record<string, string> {
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return {};
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(m[0]); } catch { return {}; }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k in FIELDS && typeof v === "string" && v.trim() && !/^(unknown|n\/a|none|null)$/i.test(v.trim())) out[k] = v.trim().slice(0, 200);
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
  if (!wanted.length) return [];

  const text = turns.map((t) => `${t.speaker === "driver" ? "Driver" : "Recruiter"}: ${t.text.replace(/<[^>]+>/g, "")}`).join("\n").slice(0, 20_000);
  const messages = [
    { role: "system", content: "You read a phone call between a trucking recruiter and a truck driver and return ONLY a JSON object, no other text. Include a key only when the DRIVER actually gave that answer in the call; never guess, never copy what the recruiter offered. Use the driver's own words, short." },
    { role: "user", content: `Keys:\n${wanted.map((k) => `- ${k}: ${FIELDS[k]}`).join("\n")}\n\nCall:\n${text}` },
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
  await recordEvent({ leadId: a.leadId, actorType: "SYSTEM", type: "TRANSCRIPT_ANSWERS", message: filled.length ? `Answers read from the call text: ${filled.join(", ")}` : "No new answers found in the call text" });
  return filled;
}
