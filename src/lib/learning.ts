// Crystal's self-improvement loop. Once a week she reads her own calls, compares them with
// what the recruiters later marked in the sheet (Interested, Application, Hired...), and
// proposes changes to her pitch. Nothing changes until the owner accepts a suggestion on the
// Learning page. Questions she could not answer are collected there too: the owner answers
// once and the answer is added to the offer draft for the Knowledge page.
import { Prisma, type User } from "@prisma/client";
import { config } from "./config";
import { db } from "./db";
import { providerFetch } from "../adapters/live/http";
import { recordEvent } from "./activity";
import { redactText } from "./redact";
import { PITCH_KEYS, cleanPitch, pitchFor, type Pitch } from "./pitch";
import { enqueue } from "./jobs/queue";
import { FactSchema, type Fact } from "./knowledge";

const URL_ = "https://api.telnyx.com/v2/ai/openai/chat/completions";
const DAY = 86_400_000;

/** Sheet statuses that mean the driver moved forward after Crystal's call. */
export const GOOD_STATUSES = ["Need to bring", "Need approval", "Application", "Call back", "Need to talk", "Need teammate", "Paired", "Hired", "Our driver – working"];
const GOOD_PIPELINE = ["INTERESTED", "DOCS_REQUESTED", "DOCS_RECEIVED", "HANDOFF_READY", "HANDED_OFF"];

type Turn = { speaker: string; text: string };
export interface CallSample { attemptId: string; good: boolean; seconds: number; result: string; turns: Turn[] }

export interface LearningStats {
  answeredCalls: number;
  talked: number;
  good: number;
  hired: number;
  goodRate: number | null;
  /** Crystal's last line before the driver hung up, on short calls; most common first. */
  dropOffs: { line: string; count: number }[];
  openQuestions: number;
}

const isDriver = (t: Turn) => t.speaker === "driver";
const isAgent = (t: Turn) => t.speaker !== "driver" && t.speaker !== "tool" && !t.text.startsWith("[");

/** The calls of the period with a transcript, labelled good / not good by what happened next. */
export async function periodCalls(orgId: string, start: Date, end: Date): Promise<CallSample[]> {
  const attempts = await db.callAttempt.findMany({
    where: { createdAt: { gte: start, lt: end }, transcript: { not: Prisma.DbNull }, lead: { orgId, isDemo: false } },
    select: { id: true, startedAt: true, endedAt: true, outcome: true, transcript: true, lead: { select: { pipelineStatus: true, recruiterStatus: true, hireStage: true } } },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return attempts.map((a) => {
    const turns = (Array.isArray(a.transcript) ? a.transcript : []) as Turn[];
    const l = a.lead;
    const good = l.hireStage === "HIRED" || GOOD_STATUSES.includes(l.recruiterStatus ?? "") || GOOD_PIPELINE.includes(l.pipelineStatus);
    const seconds = a.startedAt && a.endedAt ? Math.round((a.endedAt.getTime() - a.startedAt.getTime()) / 1000) : 0;
    const result = l.hireStage === "HIRED" ? "Hired" : l.recruiterStatus || a.outcome || l.pipelineStatus;
    return { attemptId: a.id, good, seconds, result: String(result), turns };
  });
}

/** Counts for the report; pure so it can be tested without a database. */
export function computeStats(calls: CallSample[], hired: number, openQuestions: number): LearningStats {
  const talkedCalls = calls.filter((c) => c.turns.filter(isDriver).length >= 2);
  const good = talkedCalls.filter((c) => c.good).length;
  const drops = new Map<string, number>();
  for (const c of talkedCalls) {
    if (c.good || c.turns.filter(isDriver).length > 6) continue;
    const last = [...c.turns].reverse().find(isAgent);
    if (!last) continue;
    const line = last.text.replace(/\s+/g, " ").trim().slice(0, 160);
    drops.set(line, (drops.get(line) ?? 0) + 1);
  }
  return {
    answeredCalls: calls.length,
    talked: talkedCalls.length,
    good,
    hired,
    goodRate: talkedCalls.length ? Math.round((good / talkedCalls.length) * 100) : null,
    dropOffs: [...drops.entries()].map(([line, count]) => ({ line, count })).sort((a, b) => b.count - a.count).slice(0, 5),
    openQuestions,
  };
}

interface ModelSuggestion { field?: string | null; title?: string; why?: string; proposed?: string | null }
interface ModelReply { summary?: string; suggestions?: ModelSuggestion[] }

/** Keeps at most 5 well-formed suggestions; a pitch field must be one Crystal really has. */
export function parseModelReply(content: string): { summary: string | null; suggestions: { field: keyof Pitch | null; title: string; why: string; proposed: string | null }[] } {
  const m = content.match(/\{[\s\S]*\}/);
  let j: ModelReply = {};
  try { j = m ? (JSON.parse(m[0]) as ModelReply) : {}; } catch { j = {}; }
  const suggestions = (Array.isArray(j.suggestions) ? j.suggestions : [])
    .filter((s) => s && typeof s.title === "string" && s.title.trim() && typeof s.why === "string")
    .slice(0, 5)
    .map((s) => {
      const field = PITCH_KEYS.includes(s.field as keyof Pitch) ? (s.field as keyof Pitch) : null;
      const proposed = typeof s.proposed === "string" && s.proposed.trim() ? s.proposed.trim().slice(0, 1200) : null;
      return { field: proposed ? field : null, title: s.title!.trim().slice(0, 200), why: s.why!.trim().slice(0, 800), proposed };
    });
  return { summary: typeof j.summary === "string" ? j.summary.trim().slice(0, 3000) : null, suggestions };
}

function sampleText(c: CallSample) {
  const lines = c.turns.filter((t) => isDriver(t) || isAgent(t)).map((t) => `${isDriver(t) ? "Driver" : "Crystal"}: ${t.text.replace(/<[^>]+>/g, "")}`).join("\n");
  return `--- Call (${c.good ? "GOOD: driver moved forward" : "NOT GOOD"}; result: ${c.result}; ${c.seconds}s)\n${redactText(lines).slice(0, 2500)}`;
}

async function askModel(pitch: Pitch, stats: LearningStats, calls: CallSample[]) {
  const talked = calls.filter((c) => c.turns.filter(isDriver).length >= 2);
  const sample = [...talked.filter((c) => c.good).slice(0, 15), ...talked.filter((c) => !c.good).slice(0, 15)];
  const messages = [
    { role: "system", content: "You coach Crystal, an AI phone recruiter for a US trucking company, using her real calls and what recruiters marked afterwards. Return ONLY a JSON object, no other text." },
    { role: "user", content: `Crystal's current pitch fields:\n${PITCH_KEYS.map((k) => `- ${k}: ${pitch[k]}`).join("\n")}\n\nThis week: ${stats.talked} calls where the driver talked, ${stats.good} moved forward (${stats.goodRate ?? 0}%). Lines Crystal said right before drivers hung up: ${stats.dropOffs.map((d) => `"${d.line}" x${d.count}`).join("; ") || "none"}.\n\nCompare the GOOD and NOT GOOD calls below. Return JSON:\n{"summary": "4-6 short sentences: what worked, where drivers lost interest, common objections",\n "suggestions": [{"field": one of ${PITCH_KEYS.join(", ")} or null for advice only, "title": "short", "why": "the evidence from the calls", "proposed": "the full new text for that field, or null"}]}\nAt most 5 suggestions, only ones the calls clearly support. Never invent or change pay, miles, bonus or other numbers: only reuse numbers already in the pitch. Keep Crystal honest and never pushy. For field "rules", propose only the new line to add.\n\n${sample.map(sampleText).join("\n\n")}` },
  ];
  const ask = async (strict: boolean) => {
    const res = await providerFetch(URL_, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.telnyx.apiKey}`, "Content-Type": "application/json" },
      timeoutMs: 180_000,
      body: JSON.stringify({ model: process.env.TELNYX_LEARNING_MODEL || process.env.TELNYX_EXTRACT_MODEL || "moonshotai/Kimi-K2.6", temperature: 0.2, max_tokens: 2500, enable_thinking: false, messages, ...(strict ? { response_format: { type: "json_object" } } : {}) }),
    });
    const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    return body.choices?.[0]?.message?.content ?? "";
  };
  return ask(true).catch(() => ask(false));
}

/** Builds one week's report for an organization (the week before `now`). */
export async function runLearningReport(orgId: string, now = new Date(), days = 7) {
  const end = now, start = new Date(now.getTime() - days * DAY);
  const org = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
  const calls = await periodCalls(orgId, start, end);
  const hired = await db.lead.count({ where: { orgId, isDemo: false, hireStage: "HIRED", hiredAt: { gte: start, lt: end } } });
  const openQuestions = await db.unansweredQuestion.count({ where: { status: "OPEN", lead: { orgId } } });
  const stats = computeStats(calls, hired, openQuestions);
  let summary: string | null = null, error: string | null = null;
  let suggestions: ReturnType<typeof parseModelReply>["suggestions"] = [];
  if (stats.talked < 3) summary = "Too few calls where the driver talked this week to learn from.";
  else if (config.mode !== "live" || !config.telnyx.apiKey) summary = "Numbers only: the AI review runs on the live site.";
  else {
    try {
      const r = parseModelReply(await askModel(await pitchFor(org), stats, calls));
      summary = r.summary; suggestions = r.suggestions;
    } catch (e) { error = redactText((e as Error).message).slice(0, 500); }
  }
  const report = await db.learningReport.create({ data: {
    orgId, periodStart: start, periodEnd: end, stats: stats as unknown as Prisma.InputJsonValue, summary, error,
    suggestions: { create: suggestions.map((s) => ({ orgId, field: s.field, title: s.title, why: s.why, proposed: s.proposed })) },
  } });
  await recordEvent({ actorType: "SYSTEM", orgId, type: "LEARNING_REPORT", message: `Weekly learning report: ${stats.talked} talks, ${stats.good} moved forward, ${suggestions.length} suggestions${error ? " (AI review failed)" : ""}` });
  return report;
}

/** Called by the worker every minute: queues each organization's report on Monday 04:00-04:59 UTC. */
export async function scheduleLearningReports(now = new Date()) {
  if (config.mode !== "live" || now.getUTCDay() !== 1 || now.getUTCHours() !== 4) return;
  const week = now.toISOString().slice(0, 10);
  for (const o of await db.organization.findMany({ select: { id: true } })) {
    await enqueue("learning.weekly", { orgId: o.id }, { idempotencyKey: `learning:${o.id}:${week}`, maxAttempts: 2 });
  }
}

/** Applies an accepted suggestion to the organization's pitch (Crystal uses it from the next call). */
export async function decideSuggestion(user: Pick<User, "id" | "orgId">, id: string, accept: boolean, editedText?: string) {
  const s = await db.learningSuggestion.findUnique({ where: { id } });
  if (!s || s.status !== "OPEN") return { error: "This suggestion was already decided" };
  if (accept && s.field) {
    const text = (editedText ?? s.proposed ?? "").trim();
    if (!text) return { error: "The new text is empty" };
    const org = await db.organization.findUniqueOrThrow({ where: { id: s.orgId } });
    const own = cleanPitch(org.pitch);
    const base = await pitchFor(org);
    const key = s.field as keyof Pitch;
    const next = { ...own, [key]: key === "rules" ? `${base.rules}\n${text}`.trim() : text };
    await db.organization.update({ where: { id: s.orgId }, data: { pitch: cleanPitch(next) as Prisma.InputJsonValue } });
  }
  await db.learningSuggestion.update({ where: { id }, data: { status: accept ? "ACCEPTED" : "REJECTED", decidedById: user.id, decidedAt: new Date(), ...(accept && editedText?.trim() ? { proposed: editedText.trim() } : {}) } });
  await recordEvent({ actorType: "USER", actorId: user.id, orgId: s.orgId, type: "LEARNING_DECISION", message: `${accept ? "Accepted" : "Rejected"} Crystal's suggestion: ${s.title}` });
  return { ok: true };
}

/** Open questions Crystal could not answer, grouped by the same wording, most asked first. */
export async function openQuestionGroups(orgId: string) {
  const qs = await db.unansweredQuestion.findMany({ where: { status: "OPEN", lead: { orgId } }, orderBy: { createdAt: "desc" }, take: 500, select: { id: true, question: true, createdAt: true } });
  const groups = new Map<string, { question: string; ids: string[]; last: Date }>();
  for (const q of qs) {
    const k = q.question.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    const g = groups.get(k) ?? { question: q.question, ids: [], last: q.createdAt };
    g.ids.push(q.id);
    groups.set(k, g);
  }
  return [...groups.values()].sort((a, b) => b.ids.length - a.ids.length || b.last.getTime() - a.last.getTime());
}

/** Answers a group of questions once: marks them answered and adds the answer to the offer's draft for review on Knowledge. */
export async function answerQuestionGroup(user: Pick<User, "id" | "orgId">, orgId: string, ids: string[], question: string, answer: string) {
  const text = answer.trim();
  if (!text) return { error: "Write the answer first" };
  const campaign = await db.campaign.findFirst({ where: { orgId, isDemo: false, offerId: { not: null } }, orderBy: { createdAt: "asc" } })
    ?? await db.campaign.findFirst({ where: { org: { isMain: true }, isDemo: false, offerId: { not: null } }, orderBy: { createdAt: "asc" } });
  if (!campaign?.offerId) return { error: "No offer is linked to this team's campaign" };
  const offer = await db.offer.findUniqueOrThrow({ where: { id: campaign.offerId } });
  let draft = await db.offerVersion.findFirst({ where: { offerId: offer.id, status: "DRAFT" }, orderBy: { version: "desc" } });
  if (!draft) {
    const base = offer.activeVersionId ? await db.offerVersion.findUnique({ where: { id: offer.activeVersionId } }) : null;
    const last = await db.offerVersion.findFirst({ where: { offerId: offer.id }, orderBy: { version: "desc" } });
    draft = await db.offerVersion.create({ data: { offerId: offer.id, version: (last?.version ?? 0) + 1, status: "DRAFT", synthetic: base?.synthetic ?? false, facts: base?.facts ?? [], createdById: user.id } });
  }
  const facts = (Array.isArray(draft.facts) ? draft.facts : []) as Fact[];
  const slug = question.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60) || "question";
  let key = `faq.${slug}`;
  for (let i = 2; facts.some((f) => f.key === key); i++) key = `faq.${slug}_${i}`;
  const keywords = [...new Set(question.toLowerCase().match(/[a-z]{4,}/g) ?? [])].slice(0, 8);
  const fact = FactSchema.parse({ key, category: "faq", title: question.slice(0, 200), content: text.slice(0, 1200), keywords, confirmed: true });
  await db.offerVersion.update({ where: { id: draft.id }, data: { facts: [...facts, fact] as unknown as Prisma.InputJsonValue } });
  await db.unansweredQuestion.updateMany({ where: { id: { in: ids }, lead: { orgId } }, data: { status: "ANSWERED", answer: text.slice(0, 2000) } });
  await recordEvent({ actorType: "USER", actorId: user.id, orgId, type: "QUESTION_ANSWERED", message: `Answered "${question.slice(0, 120)}" (${ids.length} asked); added to draft v${draft.version}` });
  return { ok: true, draftId: draft.id, version: draft.version };
}
