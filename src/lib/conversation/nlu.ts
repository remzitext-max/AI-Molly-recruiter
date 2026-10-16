// Deterministic language understanding for the demo/rule-based agent brain.
// Everything the driver says is untrusted input: it is only ever matched
// against patterns and never executed or used as instructions.
import { DateTime } from "luxon";

export type SlotKey =
  | "first_name"
  | "home_location"
  | "cdl_class"
  | "endorsements"
  | "restrictions"
  | "experience_years"
  | "equipment_experience"
  | "driving_type"
  | "route_preference"
  | "home_time"
  | "start_date"
  | "offer_interest"
  | "concerns";

const lc = (s: string) => ` ${s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9$'.,:\- ]+/g, " ").replace(/\s+/g, " ").trim()} `;
const has = (t: string, ...ws: string[]) => ws.some((w) => t.includes(` ${w} `) || t.includes(` ${w},`) || t.includes(` ${w}.`));

export const isAffirmative = (s: string) => /\b(yes|yeah|yep|yup|sure|ok|okay|alright|go ahead|sounds good|i do|i am|i'm interested|definitely|absolutely|of course|correct|that's right|that works|why not|go for it|uh huh)\b/i.test(s);
export const isNegative = (s: string) => /\b(no|nope|nah|not really|not interested|i'm good|im good|pass|don't think so|not right now|negative)\b/i.test(s);

export function isOptOut(s: string) {
  return /\b(stop calling|don'?t call|do not call|remove (me|my number)|take me off|unsubscribe|lose my number|never call|quit calling|stop contacting|stop texting|put me on (your|the) do not call|dnc)\b/i.test(s);
}

export function wantsHuman(s: string) {
  return /\b(real person|human|live person|talk to (molly|someone|a recruiter|a person|somebody)|speak (to|with) (molly|someone|a recruiter|a person|somebody)|transfer me|are you a (robot|bot|machine)\?? .*(person|human)|get me (molly|a recruiter))\b/i.test(s);
}

export function isAskingIfBot(s: string) {
  return /\b(are you (a )?(robot|bot|ai|real|machine|computer|recording)|is this (a )?(robot|bot|recording|ai))\b/i.test(s);
}

export function isBusy(s: string) {
  return /\b(busy|driving right now|i'?m driving|can'?t talk|bad time|not a good time|call (me )?back|in the middle of|at work right now|later|another time)\b/i.test(s);
}

export function isWrongNumber(s: string) {
  return /\b(wrong number|no one by that name|not (him|her|me)|don'?t know (who|him|her))\b/i.test(s);
}

export function isQuestion(s: string) {
  const t = s.trim().toLowerCase();
  if (t.includes("?")) return true;
  return /^(what|what's|whats|how|when|where|which|who|why|do|does|did|is|are|can|could|will|would|should|tell me|i want to know|i wanna know|any)\b/.test(t)
    || /\b(how much|what about|what's the|whats the|do you (guys )?(have|offer|pay|run|allow)|is there|are there)\b/.test(t);
}

export function isCorrection(s: string) {
  return /\b(actually|correction|i meant|i mean|sorry,? (it'?s|i)|not \w+,? (it'?s|but)|let me correct)\b/i.test(s);
}

/** Detects attempts to steer the agent ("ignore your instructions", "promise me..."). */
export function looksLikeInjection(s: string) {
  return /\b(ignore (all |your |previous )?(instructions|rules)|system prompt|you are now|pretend (to be|you)|act as|developer mode|promise me|guarantee me|say that i('?m| am) hired|mark me (as )?hired)\b/i.test(s);
}

export function containsSensitive(s: string) {
  return /\b\d{3}-?\d{2}-?\d{4}\b/.test(s) || /\b(social security|ssn|bank account|routing number|credit card|card number)\b/i.test(s);
}

const WORD_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, a: 1, an: 1, couple: 2, few: 3,
};
const num = (w: string) => (/^\d+(\.\d+)?$/.test(w) ? parseFloat(w) : WORD_NUM[w]);

export interface Extracted { key: SlotKey; value: string; raw: string }

const STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

/**
 * Extract every slot value present in an utterance, regardless of which
 * question was asked, so the agent never re-asks something already said.
 * `expecting` lets short answers ("yes", "5") be attributed to the open question.
 */
export function extractSlots(utterance: string, expecting?: SlotKey | null): Extracted[] {
  const raw = utterance;
  const t = lc(utterance);
  const out: Extracted[] = [];
  const add = (key: SlotKey, value: string) => { if (!out.some((o) => o.key === key)) out.push({ key, value, raw }); };

  // CDL class
  const cls = t.match(/\bclass\s*-?\s*(a|b|c)\b/) ?? t.match(/\b(a|b)\s*(?:class|cdl)\b/) ?? (expecting === "cdl_class" ? t.match(/^\s*(a|b|c)\s*[.,]?\s*$/) : null);
  if (cls) add("cdl_class", `Class ${cls[1].toUpperCase()}`);
  else if (has(t, "cdl a", "cdl-a")) add("cdl_class", "Class A");
  else if (expecting === "cdl_class" && has(t, "permit", "learner's", "cdl permit")) add("cdl_class", "Permit only");
  else if (expecting === "cdl_class" && /\b(no|don't have|dont have)\b.*\b(cdl|license)\b/.test(t)) add("cdl_class", "No CDL");

  // Endorsements
  const ends: string[] = [];
  if (has(t, "hazmat", "haz mat", "h endorsement")) ends.push("Hazmat (H)");
  if (has(t, "tanker", "tank", "n endorsement")) ends.push("Tanker (N)");
  if (has(t, "doubles", "triples", "t endorsement", "doubles triples")) ends.push("Doubles/Triples (T)");
  if (has(t, "x endorsement", "tanker hazmat combo")) ends.push("Hazmat+Tanker (X)");
  if (has(t, "passenger", "p endorsement")) ends.push("Passenger (P)");
  if (has(t, "twic")) ends.push("TWIC card");
  if (ends.length && (expecting === "endorsements" || has(t, "endorsement", "endorsements", "endorsed"))) add("endorsements", ends.join(", "));
  else if (expecting === "endorsements" && (/\b(no|none|nope|nothing|no endorsements)\b/.test(t))) add("endorsements", "None reported");
  else if (expecting === "endorsements" && ends.length) add("endorsements", ends.join(", "));

  // Restrictions
  if (/\b(automatic|auto)[- ]?(only|restriction)\b/.test(t) || has(t, "e restriction")) add("restrictions", "Automatic-only (E) restriction");
  else if (/\b(air brake|l restriction)\b/.test(t) && /restrict/.test(t)) add("restrictions", "Air brake (L) restriction");
  else if (expecting === "restrictions" && /\b(no|none|nope|no restrictions|clean)\b/.test(t)) add("restrictions", "None reported");

  // Experience
  const exp = t.match(/\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|a|a couple|couple|few)\s*(?:\+|plus)?\s*(years?|yrs?|months?)\b/);
  if (exp && (expecting === "experience_years" || /(driv|experience|been|otr|truck|cdl|class|running)/.test(t) || isCorrection(raw))) {
    const n = num(exp[1].replace("a couple", "couple"));
    if (n !== undefined) add("experience_years", exp[2].startsWith("month") ? `${n} months` : `${n} years`);
  } else if (expecting === "experience_years") {
    const bare = t.match(/^\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty)\s*[.,]?\s*$/);
    if (bare) add("experience_years", `${num(bare[1])} years`);
    else if (has(t, "new", "fresh", "just got", "recent graduate", "student")) add("experience_years", "Recent graduate / under 1 year");
  }

  // Equipment experience
  const eq: string[] = [];
  if (has(t, "dry van", "van", "vans")) eq.push("Dry van");
  if (has(t, "reefer", "refrigerated")) eq.push("Reefer");
  if (has(t, "flatbed", "flat bed", "step deck", "stepdeck")) eq.push("Flatbed/step deck");
  if (has(t, "tanker") && expecting === "equipment_experience") eq.push("Tanker");
  if (has(t, "car hauler", "car hauling")) eq.push("Car hauler");
  if (has(t, "intermodal", "containers")) eq.push("Intermodal");
  if (has(t, "box truck")) eq.push("Box truck");
  if (eq.length) add("equipment_experience", eq.join(", "));

  // Solo / team
  if (has(t, "team", "team driver", "with my wife", "with my husband", "with a partner", "co-driver")) add("driving_type", "Team");
  else if (has(t, "solo", "by myself", "alone")) add("driving_type", "Solo");

  // OTR / regional / local
  if (has(t, "otr", "over the road", "long haul")) add("route_preference", "OTR");
  else if (has(t, "regional")) add("route_preference", "Regional");
  else if (has(t, "local", "home daily", "home every night", "home every day")) add("route_preference", "Local");
  else if (has(t, "dedicated")) add("route_preference", "Dedicated");

  // Home time
  const ht = t.match(/\b(home (?:every|on|each) (?:weekend|week|night|day)s?|home daily|home weekly|(\d+|one|two|three|four|five|six)\s*(?:weeks?|days?)\s*(?:out|on the road)(?:[^.]*?(\d+|one|two|three|four)\s*(?:days?)\s*(?:home|off))?|every other weekend|34 hour reset|weekends? off)\b/);
  if (ht) add("home_time", ht[0].trim());
  else if (expecting === "home_time" && t.trim().length > 2 && !isQuestion(raw)) add("home_time", raw.trim().slice(0, 120));

  // Start date / availability
  const sd = t.match(/\b(asap|right away|immediately|right now|today|tomorrow|next week|this week|in (?:a |one |two |three |\d+ )(?:weeks?|days?|months?)|two weeks|2 weeks|next month|after (?:the )?(?:holidays|new year)|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|next (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/);
  if (sd && (expecting === "start_date" || /\b(start|available|ready|begin|notice|can go)\b/.test(t))) add("start_date", sd[0].trim());

  // Home location: ZIP or state
  const zip = t.match(/\b(\d{5})\b/);
  if (zip && (expecting === "home_location" || /\b(zip|live|based|from|located|out of)\b/.test(t))) add("home_location", `ZIP ${zip[1]}`);
  else {
    for (const [name, code] of Object.entries(STATES)) {
      if (t.includes(` ${name} `) || t.includes(` ${name},`) || t.includes(` ${name}.`)) {
        if (expecting === "home_location" || /\b(live|based|from|located|out of|home is|i'm in|im in|i am in|stay in)\b/.test(t)) add("home_location", code);
        break;
      }
    }
  }

  // Interest
  if (expecting === "offer_interest") {
    if (isOptOut(raw)) { /* handled elsewhere */ }
    else if (/\b(not interested|no thanks|pass|not for me)\b/i.test(raw)) add("offer_interest", "Not interested");
    else if (/\b(maybe|thinking|not sure|depends|need to think)\b/i.test(raw)) add("offer_interest", "Maybe");
    else if (isAffirmative(raw) || /\binterested\b/i.test(raw)) add("offer_interest", "Interested");
  }

  // Concerns
  if (/\b(worried|concern|concerned|problem is|issue is|don't like|dont like|bad experience|last company)\b/i.test(raw)) add("concerns", raw.trim().slice(0, 240));

  // First name
  const nm = raw.match(/\b(?:my name is|this is|i'?m|it'?s)\s+([A-Z][a-z]{1,20})\b/);
  if (nm && expecting === "first_name") add("first_name", nm[1]);
  else if (expecting === "first_name") {
    const single = raw.trim().match(/^([A-Za-z]{2,20})[.!]?$/);
    if (single && !isAffirmative(raw) && !isNegative(raw)) add("first_name", single[1][0].toUpperCase() + single[1].slice(1).toLowerCase());
  }
  return out;
}

const DOW: Record<string, number> = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };

/**
 * Parse a callback time expressed by the driver into an instant in their
 * timezone. Returns null when unclear; the raw text is still recorded.
 */
export function parseCallbackTime(s: string, now: Date, tz: string): Date | null {
  const t = s.toLowerCase();
  let base = DateTime.fromJSDate(now).setZone(tz);
  const inRel = t.match(/\bin (an?|one|two|three|four|five|\d+|half an?) (hours?|minutes?|mins?)\b/);
  if (inRel) {
    const n = inRel[1].startsWith("half") ? 0.5 : num(inRel[1]) ?? 1;
    return base.plus(inRel[2].startsWith("h") ? { minutes: Math.round(n * 60) } : { minutes: n }).toJSDate();
  }
  let dayShift = 0;
  if (/\btomorrow\b/.test(t)) dayShift = 1;
  const dow = Object.keys(DOW).find((d) => t.includes(d));
  if (dow) {
    let diff = (DOW[dow] - base.weekday + 7) % 7;
    if (diff === 0) diff = 7;
    dayShift = diff;
  }
  const tm = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/);
  let hour: number | null = null;
  let minute = 0;
  if (tm && (tm[3] || /\b(at|around|after|by)\s+\d/.test(t))) {
    hour = parseInt(tm[1], 10);
    minute = tm[2] ? parseInt(tm[2], 10) : 0;
    const ap = tm[3]?.replace(/\./g, "");
    if (ap === "pm" && hour < 12) hour += 12;
    if (ap === "am" && hour === 12) hour = 0;
    if (!ap && hour >= 1 && hour <= 7) hour += 12; // "at 3" on a recruiting call means afternoon
  } else if (/\bmorning\b/.test(t)) hour = 9;
  else if (/\b(afternoon|lunch)\b/.test(t)) hour = 13;
  else if (/\b(evening|tonight|after work)\b/.test(t)) hour = 18;
  if (hour === null && dayShift === 0) return null;
  if (hour === null) hour = 10;
  if (hour > 23 || minute > 59) return null;
  base = base.plus({ days: dayShift }).set({ hour, minute, second: 0, millisecond: 0 });
  if (base.toJSDate() <= now) base = base.plus({ days: 1 });
  return base.toJSDate();
}
