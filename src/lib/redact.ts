// Redaction for logs, activity data and transcripts. Ordinary logs must never
// contain document contents, license numbers, SSNs or full upload tokens.
const PATTERNS: [RegExp, string][] = [
  [/\b\d{3}-?\d{2}-?\d{4}\b/g, "[REDACTED-SSN?]"],
  // License numbers: an alphanumeric token containing digits after a license keyword.
  [/\b(?:license|licence|cdl|dl)(?:\s*(?:number|no\.?|#))?\s*(?:is\s*)?[:#]?\s*(?=[A-Z0-9-]*\d)[A-Z0-9-]{5,}\b/gi, "[REDACTED-LICENSE-NUMBER]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[REDACTED-CARD?]"],
  [/\/u\/[A-Za-z0-9_-]{20,}/g, "/u/[REDACTED-TOKEN]"],
];

export function redactText(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redactDeep<T>(v: T): T {
  if (typeof v === "string") return redactText(v) as unknown as T;
  if (Array.isArray(v)) return v.map(redactDeep) as unknown as T;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/token|secret|password|authorization|licenseNumber/i.test(k)) o[k] = "[REDACTED]";
      else o[k] = redactDeep(val);
    }
    return o as T;
  }
  return v;
}

export const log = {
  info: (msg: string, data?: unknown) => console.log(`[info] ${redactText(msg)}`, data ? JSON.stringify(redactDeep(data)) : ""),
  warn: (msg: string, data?: unknown) => console.warn(`[warn] ${redactText(msg)}`, data ? JSON.stringify(redactDeep(data)) : ""),
  error: (msg: string, data?: unknown) => console.error(`[error] ${redactText(msg)}`, data ? JSON.stringify(redactDeep(data)) : ""),
};
