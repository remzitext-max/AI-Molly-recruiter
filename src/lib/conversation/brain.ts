// Rule-based recruiting agent brain. It is deterministic so behaviour can be
// tested; a managed voice-agent provider (e.g. Retell) runs the same rules via
// the generated prompt + restricted tool set (see agent-config.ts).
//
// Safety properties enforced here:
// - Only approved fact content is ever spoken about pay/bonus/home time, etc.
// - Driver text is matched against patterns; it is never treated as instructions.
// - The agent can only emit actions from the closed AgentAction union.
// - Never asks for SSN, payment details or medical history.
import { DateTime } from "luxon";
import type { CallOutcome } from "@prisma/client";
import { answerQuestion, factsFor, type Fact, type FactCategory } from "../knowledge";
import {
  containsSensitive, extractSlots, isAffirmative, isAskingIfBot, isBusy, isNegative, isOptOut, isQuestion,
  isWrongNumber, looksLikeInjection, parseCallbackTime, wantsHuman, type SlotKey,
} from "./nlu";

export type HandoffReasonCode = "HUMAN_REQUESTED" | "UNKNOWN_QUESTION" | "ELIGIBILITY_EXCEPTION" | "TECHNICAL";

export type AgentAction =
  | { type: "record_slot"; key: SlotKey; value: string; raw: string; status: "CAPTURED" | "CORRECTED" | "UNCLEAR" }
  | { type: "unanswered_question"; question: string; reason: string }
  | { type: "offer_discussed"; factKeys: string[] }
  | { type: "opt_out"; raw: string }
  | { type: "wrong_number" }
  | { type: "request_transfer"; reason: HandoffReasonCode }
  | { type: "flag_handoff"; reason: HandoffReasonCode; note: string }
  | { type: "schedule_callback"; at: string | null; raw: string; by?: "crystal" | "recruiter" }
  | { type: "send_cdl_link" }
  | { type: "sensitive_data_warning" }
  | { type: "injection_attempt"; raw: string }
  | { type: "set_outcome"; outcome: CallOutcome };

export const ALLOWED_ACTIONS = new Set<AgentAction["type"]>([
  "record_slot", "unanswered_question", "offer_discussed", "opt_out", "wrong_number", "request_transfer",
  "flag_handoff", "schedule_callback", "send_cdl_link", "sensitive_data_warning", "injection_attempt", "set_outcome",
]);

export type DriverInput =
  | { type: "speech"; text: string }
  | { type: "silence" }
  | { type: "voicemail" }
  | { type: "transfer_result"; ok: boolean };

export interface AgentTurn { say: string; actions: AgentAction[]; end: boolean }

export interface SlotSpec { key: SlotKey; prompt: string; enabled: boolean; essential: boolean }

export const DEFAULT_SLOTS: SlotSpec[] = [
  { key: "cdl_class", prompt: "What class of CDL do you have right now?", enabled: true, essential: true },
  { key: "experience_years", prompt: "How long have you been driving with your CDL?", enabled: true, essential: true },
  { key: "equipment_experience", prompt: "What equipment have you mostly pulled, like dry van, reefer, or flatbed?", enabled: true, essential: true },
  { key: "endorsements", prompt: "Do you have any endorsements, like hazmat or tanker?", enabled: true, essential: false },
  { key: "restrictions", prompt: "Any restrictions on your CDL, like automatic only?", enabled: true, essential: false },
  { key: "home_location", prompt: "Where are you based? A city and state or a ZIP code works.", enabled: true, essential: true },
  { key: "route_preference", prompt: "Are you looking for OTR, regional, or local?", enabled: true, essential: false },
  { key: "driving_type", prompt: "Would you be driving solo or team?", enabled: true, essential: false },
  { key: "home_time", prompt: "How much home time do you need?", enabled: true, essential: false },
  { key: "start_date", prompt: "When would you be able to start?", enabled: true, essential: true },
];

export interface BrainContext {
  companyName: string;
  recruiterName: string; // "Molly"
  driverFirstName?: string | null;
  driverTimezone?: string | null;
  knownSlots?: Partial<Record<SlotKey, string>>;
  facts: Fact[];
  slots?: SlotSpec[];
  disclosure: string;
  recordingNotice?: string | null;
  voicemailMessage: string;
  uploadLinkTtlMinutes: number;
  /** false = no CDL text; the recruiter collects the CDL. Default true. */
  cdlBySms?: boolean;
  now?: () => Date;
}

type Phase = "TIME_CHECK" | "INTERVIEW" | "INTEREST" | "CDL_LINK" | "WRAP" | "CALLBACK_ASK" | "BOT_QUESTION" | "TRANSFERRING" | "ENDED";

export interface BrainState {
  phase: Phase;
  slots: Partial<Record<SlotKey, { value: string; status: string }>>;
  pending: SlotKey | null;
  reprompts: number;
  silence: number;
  callbackReprompted: boolean;
  interestFollowups: number;
  unanswered: string[];
  discussed: string[];
  lastAck: number;
  outcome: CallOutcome | null;
  resume?: Phase;
}

const ACKS = ["Got it.", "Thanks.", "Okay.", "Perfect.", "Great, thanks."];

const ELIGIBILITY_FLAGS = /\b(dui|dwi|felony|felonies|suspended|revoked|accident|accidents|tickets?|violations?|sap program|failed (a )?(drug|hair) test|positive test|clearinghouse|criminal|record)\b/i;

export class RecruitingBrain {
  state: BrainState;
  private slots: SlotSpec[];
  constructor(private ctx: BrainContext, state?: BrainState) {
    this.slots = (ctx.slots ?? DEFAULT_SLOTS).filter((s) => s.enabled);
    this.state = state ?? {
      phase: "TIME_CHECK", slots: {}, pending: null, reprompts: 0, silence: 0, callbackReprompted: false,
      interestFollowups: 0, unanswered: [], discussed: [], lastAck: -1, outcome: null,
    };
    if (!state && ctx.knownSlots) {
      for (const [k, v] of Object.entries(ctx.knownSlots)) if (v) this.state.slots[k as SlotKey] = { value: v, status: "KNOWN" };
    }
  }

  private now() { return this.ctx.now ? this.ctx.now() : new Date(); }

  private ack() {
    // rotate acknowledgements to avoid repetitive fillers; skip every third turn
    this.state.lastAck = (this.state.lastAck + 1) % (ACKS.length + 1);
    return this.state.lastAck === ACKS.length ? "" : ACKS[this.state.lastAck];
  }

  start(): AgentTurn {
    const name = this.ctx.driverFirstName ? `Hi ${this.ctx.driverFirstName}, ` : "Hi, ";
    const disclosure = this.ctx.disclosure.replace(/^Hi,?\s*/i, "");
    const parts = [`${name}${disclosure}`];
    if (this.ctx.recordingNotice) parts.push(this.ctx.recordingNotice);
    parts.push("You'd reached out about a driving position. Is now an okay time for a few quick questions?");
    return { say: parts.join(" "), actions: [], end: false };
  }

  handle(input: DriverInput): AgentTurn {
    const s = this.state;
    if (s.phase === "ENDED") return { say: "", actions: [], end: true };

    if (input.type === "voicemail") {
      return this.end(this.ctx.voicemailMessage, [{ type: "set_outcome", outcome: "VOICEMAIL_LEFT" }], "VOICEMAIL_LEFT");
    }
    if (input.type === "transfer_result") {
      if (input.ok) {
        return this.end(`You're now being connected to ${this.ctx.recruiterName}, a member of our recruiting team. Thanks for your time.`, [], "HUMAN_REQUESTED");
      }
      s.phase = "CALLBACK_ASK";
      return { say: `I'm sorry, ${this.ctx.recruiterName} isn't available right this moment. What's a good time for her to call you back?`, actions: [], end: false };
    }
    if (input.type === "silence") {
      s.silence++;
      if (s.silence >= 2) return this.end("Sorry, I'm having trouble hearing you. We'll try you another time. Take care.", [], "INCOMPLETE");
      return { say: "Are you still there?", actions: [], end: false };
    }

    s.silence = 0;
    const text = input.text.trim();
    const actions: AgentAction[] = [];
    const pre: string[] = [];

    if (!text) return this.handle({ type: "silence" });

    // 1. Hard stops first.
    if (isOptOut(text)) {
      return this.end("Understood. I'll make sure we don't contact you again. Sorry to bother you, and take care.", [{ type: "opt_out", raw: text }], "OPT_OUT");
    }
    if (isWrongNumber(text)) {
      return this.end("Sorry about that, I must have the wrong number. Have a good day.", [{ type: "wrong_number" }], "WRONG_NUMBER");
    }
    if (containsSensitive(text)) {
      actions.push({ type: "sensitive_data_warning" });
      pre.push("Just so you know, we don't need personal numbers or financial details on this call, so please don't share those.");
    }
    if (looksLikeInjection(text)) {
      actions.push({ type: "injection_attempt", raw: text });
      pre.push("I can only share the approved details for this position, and Molly makes all final decisions.");
    }
    if (wantsHuman(text) || (s.phase === "BOT_QUESTION" && isAffirmative(text))) {
      s.phase = "TRANSFERRING";
      return { say: [...pre, `Of course. Let me try to connect you with ${this.ctx.recruiterName} now.`].join(" "), actions: [...actions, { type: "request_transfer", reason: "HUMAN_REQUESTED" }], end: false };
    }
    if (isAskingIfBot(text)) {
      s.resume = s.phase === "TIME_CHECK" || s.phase === "BOT_QUESTION" ? "INTERVIEW" : s.phase;
      s.phase = "BOT_QUESTION";
      return { say: `Yes, I'm an AI assistant working with ${this.ctx.recruiterName}. I can answer basic questions and get you set up with her. Would you rather talk to ${this.ctx.recruiterName} directly?`, actions, end: false };
    }
    if (s.phase === "BOT_QUESTION") {
      s.phase = s.resume ?? "INTERVIEW";
      if (isNegative(text)) pre.push("Okay, no problem.");
    }

    // 2. Busy / callback requests.
    if (s.phase === "TIME_CHECK" && (isBusy(text) || (isNegative(text) && !isQuestion(text)))) {
      const at = this.tryParseCallback(text);
      if (at) return this.confirmCallback(at, text, pre, actions);
      s.phase = "CALLBACK_ASK";
      return { say: [...pre, "No problem. When's a better time to call you back?"].join(" "), actions, end: false };
    }
    if (s.phase !== "TIME_CHECK" && s.phase !== "CALLBACK_ASK" && isBusy(text) && /\b(call (me )?back|later|another time|can'?t talk)\b/i.test(text)) {
      const at = this.tryParseCallback(text);
      if (at) return this.confirmCallback(at, text, pre, actions);
      s.phase = "CALLBACK_ASK";
      return { say: [...pre, "Sure. What time works better for you?"].join(" "), actions, end: false };
    }
    if (s.phase === "CALLBACK_ASK") {
      const at = this.tryParseCallback(text);
      if (at) return this.confirmCallback(at, text, pre, actions);
      if (!s.callbackReprompted) {
        s.callbackReprompted = true;
        return { say: "What day and time works best for you?", actions, end: false };
      }
      return this.end(`Okay, I'll pass that along and ${this.ctx.recruiterName} will reach out. Take care.`, [...actions, { type: "schedule_callback", at: null, raw: text }], "CALLBACK");
    }

    // 3. Extract any information volunteered (never re-ask it).
    const expecting = s.phase === "INTERVIEW" ? s.pending : s.phase === "INTEREST" ? "offer_interest" : null;
    const extracted = extractSlots(text, expecting);
    let filledPending = false;
    for (const e of extracted) {
      const prev = s.slots[e.key];
      const status = prev && prev.value !== e.value ? "CORRECTED" : "CAPTURED";
      if (prev && prev.value === e.value) continue;
      s.slots[e.key] = { value: e.value, status };
      actions.push({ type: "record_slot", key: e.key, value: e.value, raw: text, status });
      if (e.key === s.pending) filledPending = true;
    }

    if (ELIGIBILITY_FLAGS.test(text) && !isQuestion(text)) {
      actions.push({ type: "flag_handoff", reason: "ELIGIBILITY_EXCEPTION", note: text });
      pre.push(`Thanks for being upfront. ${this.ctx.recruiterName} will review that with you personally; I can't make that call.`);
    }

    // 4. Answer driver questions before returning to the interview.
    const asked = isQuestion(text);
    if (asked) pre.push(this.answer(text, actions));

    // 5. Continue by phase.
    if (s.phase === "TIME_CHECK") {
      s.phase = "INTERVIEW";
      if (!asked && !pre.length) pre.push(this.ack() || "Great.");
      return this.nextInterviewStep(pre, actions);
    }

    if (s.phase === "INTERVIEW") {
      if (s.pending && !filledPending && !asked && !extracted.length && !pre.length) {
        s.reprompts++;
        if (s.reprompts === 1) {
          return { say: `Sorry, I didn't quite catch that. ${this.promptFor(s.pending)}`, actions, end: false };
        }
        // Still unclear: record for human review and move on.
        s.slots[s.pending] = { value: text, status: "UNCLEAR" };
        actions.push({ type: "record_slot", key: s.pending, value: text, raw: text, status: "UNCLEAR" });
        pre.push(`No worries, I'll note that for ${this.ctx.recruiterName}.`);
      } else if (!asked && (filledPending || extracted.length)) {
        const a = this.ack();
        if (a && !pre.length) pre.push(a);
      }
      return this.nextInterviewStep(pre, actions);
    }

    if (s.phase === "INTEREST") {
      const interest = s.slots.offer_interest?.value;
      if (interest === "Interested" || (isAffirmative(text) && !asked)) {
        if (!interest) { s.slots.offer_interest = { value: "Interested", status: "CAPTURED" }; actions.push({ type: "record_slot", key: "offer_interest", value: "Interested", raw: text, status: "CAPTURED" }); }
        if (this.ctx.cdlBySms === false) {
          s.phase = "WRAP";
          return { say: [...pre, `Great. ${this.ctx.recruiterName} will reach out to go over next steps and get a copy of your CDL. Anything you'd like me to pass along to her?`].join(" "), actions, end: false };
        }
        s.phase = "CDL_LINK";
        return { say: [...pre, `Great. The next step is a copy of your CDL so ${this.ctx.recruiterName} can review it. Can I text a secure upload link to this number?`].join(" "), actions, end: false };
      }
      if (interest === "Not interested") {
        s.phase = "WRAP";
        return { say: [...pre, `I understand. Is there anything you'd like me to pass along to ${this.ctx.recruiterName}?`].join(" "), actions, end: false };
      }
      if (asked) return { say: [...pre, "Does the position sound like something you'd want to move forward with?"].join(" "), actions, end: false };
      s.interestFollowups++;
      if (s.interestFollowups >= 2) {
        s.phase = "WRAP";
        return { say: [...pre, `That's fair. I'll have ${this.ctx.recruiterName} follow up so you can talk it through. Anything specific you want her to cover?`].join(" "), actions, end: false };
      }
      return { say: [...pre, "No pressure at all. Is there a question or concern I can help with?"].join(" "), actions, end: false };
    }

    if (s.phase === "CDL_LINK") {
      if (isAffirmative(text) && !isNegative(text)) {
        actions.push({ type: "send_cdl_link" });
        s.phase = "WRAP";
        const ttl = this.ctx.uploadLinkTtlMinutes >= 60 ? `${Math.round(this.ctx.uploadLinkTtlMinutes / 60)} hour${this.ctx.uploadLinkTtlMinutes >= 120 ? "s" : ""}` : `${this.ctx.uploadLinkTtlMinutes} minutes`;
        return { say: [...pre, `Okay, I'm sending it now. The link is private and expires in ${ttl}. Anything else you'd like me to pass along to ${this.ctx.recruiterName}?`].join(" "), actions, end: false };
      }
      if (isNegative(text)) {
        s.phase = "WRAP";
        return { say: [...pre, `No problem, ${this.ctx.recruiterName} can help with that when she calls. Anything else you'd like me to pass along?`].join(" "), actions, end: false };
      }
      return { say: [...pre, "Is it okay if I text the upload link to this number?"].join(" "), actions, end: false };
    }

    if (s.phase === "WRAP") {
      if (asked) return { say: [...pre, "Anything else?"].join(" "), actions, end: false };
      const interested = s.slots.offer_interest?.value === "Interested";
      const maybe = s.slots.offer_interest?.value === "Maybe" || (!interested && s.slots.offer_interest?.value !== "Not interested");
      if (!isNegative(text) && text.length > 12) {
        actions.push({ type: "record_slot", key: "concerns", value: text.slice(0, 240), raw: text, status: "CAPTURED" });
      }
      const outcome: CallOutcome = interested ? "INTERESTED" : maybe ? "CALLBACK" : "NOT_INTERESTED";
      const closing = interested
        ? `Thanks${this.ctx.driverFirstName ? `, ${this.ctx.driverFirstName}` : ""}. ${this.ctx.recruiterName} will review everything and follow up with you. Drive safe.`
        : maybe
          ? `Thanks for your time. ${this.ctx.recruiterName} will follow up to answer your questions. Drive safe.`
          : "Thanks for your time, and drive safe.";
      if (maybe && !interested) actions.push({ type: "schedule_callback", at: null, raw: "Driver undecided; recruiter follow-up" });
      return this.end([...pre, closing].join(" "), actions, outcome);
    }

    return { say: pre.join(" ") || "Sorry, could you say that again?", actions, end: false };
  }

  private promptFor(key: SlotKey) {
    return this.slots.find((x) => x.key === key)?.prompt ?? "Could you tell me a bit more?";
  }

  private nextInterviewStep(pre: string[], actions: AgentAction[]): AgentTurn {
    pre = [...pre];
    const s = this.state;
    const missing = this.slots.find((sp) => !s.slots[sp.key]);
    if (missing) {
      if (s.pending !== missing.key) s.reprompts = 0;
      s.pending = missing.key;
      return { say: [...pre, missing.prompt].filter(Boolean).join(" "), actions, end: false };
    }
    s.pending = null;
    s.phase = "INTEREST";
    const pitch = this.pitch(actions);
    if (pre.length === 1 && ACKS.includes(pre[0])) pre = []; // the pitch opens with its own thanks
    return { say: [...pre, pitch].filter(Boolean).join(" "), actions, end: false };
  }

  /** Match up to two approved benefits to the driver's stated needs. */
  private pitch(actions: AgentAction[]): string {
    const s = this.state;
    const want: FactCategory[] = ["pay"];
    if (s.slots.home_time) want.push("home_time");
    if (s.slots.route_preference) want.push("operating_area");
    if (s.slots.equipment_experience) want.push("equipment");
    const chosen: Fact[] = [];
    for (const c of want) {
      const f = factsFor(this.ctx.facts, c).find((x) => !s.discussed.includes(x.key));
      if (f && chosen.length < 2) chosen.push(f);
    }
    if (!chosen.length) {
      return `Thanks, that's really helpful. ${this.ctx.recruiterName} will go over the specific offer details with you. Does this sound like something you'd want to explore?`;
    }
    s.discussed.push(...chosen.map((f) => f.key));
    actions.push({ type: "offer_discussed", factKeys: chosen.map((f) => f.key) });
    return `Thanks, that's helpful. Here's a quick overview. ${chosen.map((f) => f.content).join(" ")} Does that sound like something you'd be interested in?`;
  }

  private answer(question: string, actions: AgentAction[]): string {
    const r = answerQuestion(question, this.ctx.facts);
    if (r.kind === "answer") {
      const keys = r.facts.map((f) => f.key);
      this.state.discussed.push(...keys.filter((k) => !this.state.discussed.includes(k)));
      actions.push({ type: "offer_discussed", factKeys: keys });
      return r.facts.map((f) => f.content).join(" ");
    }
    const reason = r.kind === "contradictory" ? "Conflicting approved facts" : r.kind === "missing" ? r.reason : "Topic not in approved knowledge base";
    this.state.unanswered.push(question);
    actions.push({ type: "unanswered_question", question, reason });
    return `That's a good question. I don't want to give you wrong information, so I've noted it and ${this.ctx.recruiterName} will confirm it with you.`;
  }

  private tryParseCallback(text: string): Date | null {
    return parseCallbackTime(text, this.now(), this.ctx.driverTimezone || "America/Chicago");
  }

  private confirmCallback(at: Date, raw: string, pre: string[], actions: AgentAction[]): AgentTurn {
    const tz = this.ctx.driverTimezone || "America/Chicago";
    const when = DateTime.fromJSDate(at).setZone(tz).toFormat("cccc 'at' h:mm a");
    return this.end([...pre, `Got it. We'll call you back ${when} your time. Talk to you then.`].join(" "), [...actions, { type: "schedule_callback", at: at.toISOString(), raw }], "CALLBACK");
  }

  private end(say: string, actions: AgentAction[], outcome: CallOutcome): AgentTurn {
    this.state.phase = "ENDED";
    this.state.outcome = outcome;
    if (!actions.some((a) => a.type === "set_outcome")) actions.push({ type: "set_outcome", outcome });
    return { say, actions, end: true };
  }
}
