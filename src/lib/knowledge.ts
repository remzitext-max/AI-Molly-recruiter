// Approved, versioned company/offer facts and the retrieval used by the agent.
// The agent may only speak fact content verbatim; it never composes numbers.
import { z } from "zod";
import { db } from "./db";

export const FACT_CATEGORIES = [
  "company", "pay", "bonus", "home_time", "equipment", "operating_area", "deductions",
  "orientation", "travel", "requirements", "benefits", "faq", "recruiter_contact",
] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];

export const FactSchema = z.object({
  key: z.string().min(1).max(80).regex(/^[a-z0-9_.-]+$/),
  category: z.enum(FACT_CATEGORIES),
  title: z.string().min(1).max(200),
  content: z.string().max(1200), // exact approved wording the agent may say
  keywords: z.array(z.string().max(60)).default([]),
  confirmed: z.boolean().default(true), // false = known gap; agent must defer to Molly
});
export type Fact = z.infer<typeof FactSchema>;
export const FactsSchema = z.array(FactSchema).superRefine((facts, ctx) => {
  const seen = new Set<string>();
  facts.forEach((f, i) => {
    if (seen.has(f.key)) ctx.addIssue({ code: "custom", message: `Duplicate fact key ${f.key}`, path: [i, "key"] });
    seen.add(f.key);
  });
});

// Topic vocabulary used to understand which category a driver question is about.
const CATEGORY_TERMS: Record<FactCategory, string[]> = {
  company: ["company", "who are you", "who is this", "agency", "carrier", "name of the company", "how long have you"],
  pay: ["pay", "paid", "cpm", "cents", "per mile", "salary", "money", "make", "weekly", "rate", "percentage", "gross", "detention", "layover", "how much"],
  bonus: ["bonus", "sign on", "sign-on", "signing", "referral", "safety bonus", "incentive"],
  home_time: ["home time", "home", "weekend", "weekends", "days off", "time off", "out for", "reset", "family"],
  equipment: ["truck", "trucks", "equipment", "tractor", "trailer", "automatic", "manual", "freightliner", "volvo", "kenworth", "peterbilt", "apu", "inverter", "fridge", "camera", "cameras", "governed", "speed"],
  operating_area: ["area", "areas", "lanes", "region", "regions", "states", "where do you run", "routes", "run", "midwest", "southeast", "otr", "regional", "local", "canada"],
  deductions: ["deduction", "deductions", "escrow", "insurance cost", "fees", "lease", "charge", "charges"],
  orientation: ["orientation", "training", "onboarding", "first day", "how long is orientation"],
  travel: ["travel", "bus", "ticket", "hotel", "flight", "get to orientation", "transportation"],
  requirements: ["requirement", "requirements", "qualify", "experience needed", "how much experience", "accidents", "tickets", "dui", "felony", "felonies", "age", "years", "clean record", "mvr", "drug test", "hair test", "sap", "clearinghouse"],
  benefits: ["benefit", "benefits", "health", "dental", "vision", "401k", "insurance", "pto", "vacation", "pet", "pets", "rider", "riders"],
  faq: [],
  recruiter_contact: ["molly", "recruiter", "call you back", "your number", "contact", "phone number", "reach you"],
};

// Unambiguous topic nouns. A question mentioning one of these is never answered
// with a fact from a different category (e.g. "pets in the truck" != truck specs).
const DISTINCT_TOPICS: [string, FactCategory][] = [
  ["pet", "benefits"], ["pets", "benefits"], ["dog", "benefits"], ["rider", "benefits"], ["riders", "benefits"], ["passenger", "benefits"],
  ["health", "benefits"], ["dental", "benefits"], ["vision", "benefits"], ["401k", "benefits"], ["pto", "benefits"], ["vacation", "benefits"],
  ["bonus", "bonus"], ["escrow", "deductions"], ["deduction", "deductions"], ["deductions", "deductions"], ["lease", "deductions"],
  ["orientation", "orientation"], ["hotel", "travel"], ["bus", "travel"], ["flight", "travel"],
  ["dui", "requirements"], ["dwi", "requirements"], ["felony", "requirements"], ["accident", "requirements"], ["accidents", "requirements"], ["clearinghouse", "requirements"],
];

const STOP = new Set(["the", "a", "an", "is", "are", "do", "does", "you", "your", "what", "whats", "what's", "how", "about", "i", "me", "my", "to", "of", "for", "and", "or", "it", "can", "on", "in", "with", "there", "any", "be", "will", "would", "tell", "get", "guys", "y'all", "yall"]);

function norm(s: string) {
  return ` ${s.toLowerCase().replace(/[^a-z0-9$.\- ]+/g, " ").replace(/\s+/g, " ").trim()} `;
}

export interface FactMatch { fact: Fact; score: number }
export type AnswerResult =
  | { kind: "answer"; facts: Fact[]; categories: FactCategory[] }
  | { kind: "missing"; categories: FactCategory[]; reason: string }
  | { kind: "contradictory"; categories: FactCategory[]; facts: Fact[] }
  | { kind: "unknown_topic" };

export function detectCategories(question: string): FactCategory[] {
  const q = norm(question);
  const hits: { c: FactCategory; n: number }[] = [];
  for (const c of FACT_CATEGORIES) {
    let n = 0;
    for (const t of CATEGORY_TERMS[c]) if (q.includes(` ${t} `) || q.includes(` ${t}s `) || q.includes(` ${t}?`)) n += t.includes(" ") ? 2 : 1;
    if (n) hits.push({ c, n });
  }
  hits.sort((a, b) => b.n - a.n);
  return hits.map((h) => h.c);
}

function scoreFact(question: string, fact: Fact, cats: FactCategory[]): number {
  const q = norm(question).replace(/-/g, " ");
  let kw = 0;
  for (const k of fact.keywords) {
    const kk = norm(k).trim().replace(/-/g, " ");
    if (kk && (q.includes(` ${kk} `) || q.includes(` ${kk}s `))) kw += kk.includes(" ") ? 3 : 2;
  }
  for (const w of norm(fact.title).trim().split(" ")) if (w.length > 3 && !STOP.has(w) && q.includes(` ${w} `)) kw += 0.5;
  // A topic match alone is not enough: the fact itself must be about what was asked.
  if (kw < 2) return 0;
  // If the question names a distinct topic this fact does not cover, do not answer with it.
  for (const [term, cat] of DISTINCT_TOPICS) {
    if (cat !== fact.category && q.includes(` ${term} `) && !fact.keywords.some((k) => norm(k).trim() === term)) return 0;
  }
  const ci = cats.indexOf(fact.category);
  return kw + (ci === 0 ? 3 : ci > 0 ? 1 : 0);
}

const money = (s: string) => (s.match(/\$\s?\d[\d,.]*|\d+(\.\d+)?\s?(cents|cpm|%)/gi) ?? []).map((m) => m.replace(/\s/g, "").toLowerCase());

/** Find approved facts answering a driver question. Never synthesizes content. */
export function answerQuestion(question: string, facts: Fact[]): AnswerResult {
  const cats = detectCategories(question);
  const scored = facts
    .map((fact) => ({ fact, score: scoreFact(question, fact, cats) }))
    .filter((m) => m.score >= 2)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    if (!cats.length) return { kind: "unknown_topic" };
    return { kind: "missing", categories: cats, reason: "No approved fact for this topic" };
  }
  const top = scored[0];
  if (!top.fact.confirmed || !top.fact.content.trim()) {
    return { kind: "missing", categories: [top.fact.category], reason: "Fact exists but is not confirmed" };
  }
  // Contradiction guard: two equally relevant confirmed facts in the same
  // category quoting different amounts -> do not guess.
  const rival = scored.find((m) => m !== top && m.fact.category === top.fact.category && m.score >= top.score - 0.5 && m.fact.confirmed);
  if (rival) {
    const a = money(top.fact.content).join("|");
    const b = money(rival.fact.content).join("|");
    if (a && b && a !== b) return { kind: "contradictory", categories: [top.fact.category], facts: [top.fact, rival.fact] };
  }
  return { kind: "answer", facts: [top.fact], categories: [top.fact.category] };
}

export function factsFor(facts: Fact[], category: FactCategory) {
  return facts.filter((f) => f.category === category && f.confirmed && f.content.trim());
}

export async function getActiveOfferVersion(offerId: string | null | undefined) {
  if (!offerId) return null;
  const offer = await db.offer.findUnique({ where: { id: offerId } });
  if (!offer?.activeVersionId) return null;
  const v = await db.offerVersion.findUnique({ where: { id: offer.activeVersionId } });
  if (!v || v.status !== "PUBLISHED") return null;
  return { ...v, factsParsed: FactsSchema.parse(v.facts) };
}
