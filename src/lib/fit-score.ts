// Fit score: a 0-100 guide for recruiters built from the driver's own screening
// answers against the company's published requirements. It never decides hiring
// and never reaches the driver; unknown answers lower confidence, not eligibility.

export interface FitRules {
  /** Minimum CDL experience for a solo driver, in months. */
  minSoloMonths: number;
  /** Minimum CDL experience for a team driver, in months. */
  minTeamMonths: number;
  /** A SAP history rules the driver out. */
  sapKnockout: boolean;
  /** Only Class A CDL fits. */
  requireClassA: boolean;
}

// TBT express handbook: 2 years solo or 1 year team, no SAP history, dry van (Class A).
export const DEFAULT_FIT_RULES: FitRules = { minSoloMonths: 24, minTeamMonths: 12, sapKnockout: true, requireClassA: true };

export function fitRulesFrom(json: unknown): FitRules {
  const j = (json && typeof json === "object" ? json : {}) as Partial<FitRules>;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
  return {
    minSoloMonths: num(j.minSoloMonths, DEFAULT_FIT_RULES.minSoloMonths),
    minTeamMonths: num(j.minTeamMonths, DEFAULT_FIT_RULES.minTeamMonths),
    sapKnockout: typeof j.sapKnockout === "boolean" ? j.sapKnockout : DEFAULT_FIT_RULES.sapKnockout,
    requireClassA: typeof j.requireClassA === "boolean" ? j.requireClassA : DEFAULT_FIT_RULES.requireClassA,
  };
}

const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, half: 0.5 };

/** Driving experience in months from what the driver said ("2+ years", "18 months", "a year and a half"). */
export function experienceMonths(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = text.toLowerCase().replace(/(\d),(\d)/g, "$1.$2");
  if (/\b(no|none|zero|never|just got|new driver|fresh|student)\b/.test(t) && !/\d/.test(t)) return 0;
  let months = 0;
  let found = false;
  const re = /(\d+(?:\.\d+)?|\b(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half)\b)\s*\+?\s*(?:and a half\s*)?(years?|yrs?|y\b|months?|mos?|weeks?|wks?)(\s+and a half)?/g;
  for (const m of t.matchAll(re)) {
    const n = /\d/.test(m[1]) ? Number(m[1]) : WORDS[m[1]];
    if (n === undefined) continue;
    const half = /and a half/.test(m[0]) ? 0.5 : 0; // "1 and a half years", "a year and a half"
    const unit = m[2];
    months += unit.startsWith("y") ? (n + half) * 12 : unit.startsWith("w") ? (n + half) / 4.3 : n + half;
    found = true;
  }
  if (!found && /^\s*\d+(\.\d+)?\s*\+?\s*$/.test(t)) return Number(t.replace(/[^\d.]/g, "")) * 12; // bare number: years
  return found ? Math.round(months) : null;
}

const yes = (v: string | undefined) => !!v && /\b(yes|yeah|yep|have|had|did|one|two|1|2)\b/i.test(v) && !/^\s*(no|nope|never|none|clean|clear)\b/i.test(v);

export interface FitResult { score: number | null; label: "Strong fit" | "Possible fit" | "Weak fit" | "Not a fit" | "Not enough answers"; reasons: string[]; missing: string[]; knockout: boolean }

/** Scores screening answers keyed like ScreeningField.key (reportedValue or verifiedValue). */
export function fitScore(answers: Record<string, string | null | undefined>, rules: FitRules = DEFAULT_FIT_RULES): FitResult {
  const a = Object.fromEntries(Object.entries(answers).filter(([, v]) => v && v.trim()).map(([k, v]) => [k, v!.trim()])) as Record<string, string>;
  const reasons: string[] = [];
  const missing: string[] = [];
  let score = 100;
  let knockout = false;

  const team = /team/i.test(a.driving_type ?? "");
  const need = team ? rules.minTeamMonths : rules.minSoloMonths;
  const exp = experienceMonths(a.experience_years);
  if (exp === null) { missing.push("experience"); score -= 15; }
  else if (exp < need) { knockout = true; reasons.push(`Experience ${a.experience_years} (needs ${need >= 12 ? `${need / 12} yr` : `${need} mo`}${team ? " team" : " solo"})`); }

  if (!a.sap_history) { missing.push("SAP"); score -= 10; }
  else if (yes(a.sap_history) && rules.sapKnockout) { knockout = true; reasons.push("SAP history"); }

  if (a.cdl_class) {
    if (rules.requireClassA && !/\b(a|class a|cdl a|cdl-a)\b/i.test(a.cdl_class)) { knockout = true; reasons.push(`CDL ${a.cdl_class}, needs Class A`); }
  } else { missing.push("CDL class"); score -= 5; }

  if (!a.accidents_at_fault) { missing.push("accidents"); score -= 5; }
  else if (yes(a.accidents_at_fault)) { score -= 25; reasons.push(`At-fault accident: ${a.accidents_at_fault}`); }

  const eng = (a.english_level ?? "").toLowerCase();
  if (eng.startsWith("poor")) { score -= 30; reasons.push("English rated poor"); }
  else if (eng.startsWith("fair")) { score -= 10; reasons.push("English rated fair"); }

  if (/not interested|^no\b/i.test(a.offer_interest ?? "")) { score -= 40; reasons.push("Not interested in the offer"); }

  if (!knockout && missing.length >= 3) return { score: null, label: "Not enough answers", reasons, missing, knockout };
  if (knockout) score = Math.min(score, 20);
  score = Math.max(0, Math.min(100, Math.round(score)));
  const label = knockout ? "Not a fit" : score >= 80 ? "Strong fit" : score >= 55 ? "Possible fit" : "Weak fit";
  return { score, label, reasons, missing, knockout };
}

/** Builds the answers map from stored screening fields, preferring a recruiter-verified value. */
export function answersOf(fields: { key: string; reportedValue: string | null; verifiedValue?: string | null }[]) {
  return Object.fromEntries(fields.map((f) => [f.key, f.verifiedValue || f.reportedValue]));
}

export const fitTone = (r: FitResult) => (r.knockout ? "bad" : r.score === null ? "" : r.score >= 80 ? "ok" : r.score >= 55 ? "info" : "warn");

/** "85 · Strong fit" / "Not a fit: SAP history" for lists and the Telegram card. */
export const fitText = (r: FitResult) =>
  r.score === null ? r.label : `${r.score}/100 · ${r.label}${r.reasons.length ? `: ${r.reasons.join("; ")}` : ""}`;
