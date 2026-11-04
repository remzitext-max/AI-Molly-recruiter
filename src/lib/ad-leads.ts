import type { IncomingLead } from "../adapters/types";

/**
 * Leads from video ad platforms (YouTube via Google Ads lead forms, TikTok via a
 * Make/Zapier webhook) turned into an IncomingLead. Two shapes are accepted:
 * - Google Ads lead form webhook: { lead_id, google_key, campaign_id, form_id, is_test, user_column_data: [{ column_id, column_name, string_value }] }
 * - flat JSON: { platform, lead_id, name | first_name + last_name, phone, email, state, position, experience, sap, cdl, campaign, ad }
 */
export interface AdLead { lead: IncomingLead; key?: string; isTest: boolean; sapYes: boolean; answers: Record<string, string> }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

function pick(a: Record<string, string>, ...re: RegExp[]) {
  for (const r of re) for (const [k, v] of Object.entries(a)) if (r.test(k) && v.trim()) return v.trim();
  return undefined;
}

function splitName(full?: string) {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") || undefined };
}

export function parseAdLead(body: unknown, platformHint?: string): AdLead | { error: string } {
  if (!body || typeof body !== "object") return { error: "Body must be JSON" };
  const b = body as Record<string, unknown>;
  const answers: Record<string, string> = {};
  let platform = (platformHint ?? (typeof b.platform === "string" ? b.platform : "")).toLowerCase();

  if (Array.isArray(b.user_column_data)) {
    platform = platform || "google";
    for (const c of b.user_column_data as Record<string, unknown>[]) {
      const k = norm(String(c.column_id ?? c.column_name ?? ""));
      const v = c.string_value ?? c.value;
      if (k && typeof v === "string") answers[k] = v;
      // Custom questions: keep the question text too, it is what recruiters read.
      if (typeof c.column_name === "string" && typeof v === "string") answers[norm(c.column_name)] ||= v;
    }
  } else {
    for (const [k, v] of Object.entries(b)) if (typeof v === "string" || typeof v === "number") answers[norm(k)] = String(v);
  }

  const phone = pick(answers, /^phone_number$/, /^user_phone$/, /phone/);
  if (!phone) return { error: "No phone number in lead" };
  const leadId = String(b.lead_id ?? b.leadId ?? answers.lead_id ?? "").trim();
  const named = splitName(pick(answers, /^full_name$/, /^name$/));
  const firstName = pick(answers, /^first_name$/) ?? named.firstName;
  const lastName = pick(answers, /^last_name$/) ?? named.lastName;
  const sap = pick(answers, /sap/, /drug|alcohol|clearinghouse/);
  const position = pick(answers, /^position$/, /solo|team|driver_type/);
  const src = platform === "tiktok" ? "TIKTOK" : platform === "google" || platform === "youtube" ? "GOOGLE_ADS" : "AD_LEADS";

  const lead: IncomingLead = {
    sourceSystem: src,
    sourceRecordId: leadId || `phone:${phone.replace(/\D/g, "")}`,
    firstName, lastName, phone,
    email: pick(answers, /^email$/, /^user_email$/, /email/),
    state: pick(answers, /^state$/, /^region$/)?.slice(0, 2),
    zip: pick(answers, /^postal_code$/, /^zip/),
    fb: { leadId: leadId || undefined, campaign: String(b.campaign_name ?? b.campaign ?? b.campaign_id ?? "") || undefined, ad: String(b.ad_name ?? b.ad ?? b.creative_id ?? "") || undefined, form: String(b.form_name ?? b.form_id ?? "") || undefined },
    raw: { via: src.toLowerCase(), answers, ...(position ? { position } : {}) },
  };
  return {
    lead,
    key: typeof b.google_key === "string" ? b.google_key : undefined,
    isTest: b.is_test === true || b.is_test === "true",
    sapYes: !!sap && /^(y|yes|true)/i.test(sap.trim()),
    answers,
  };
}
