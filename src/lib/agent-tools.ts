// Provider-neutral handler for the restricted voice-agent tools. Each provider
// route authenticates the request and finds the call attempt, then calls this.
import { db } from "./db";
import { applyAgentAction } from "./calls";
import { tabRecruiterPhone } from "./recruiter-tab";
import { answerQuestion, getActiveOfferVersion } from "./knowledge";

export async function findToolAttempt(where: { providerCallId?: string; attemptId?: string }) {
  return db.callAttempt.findFirst({
    where: { OR: [{ providerCallId: where.providerCallId || "-" }, { id: where.attemptId || "-" }] },
    include: { lead: { include: { campaign: true } } },
  });
}

type ToolAttempt = NonNullable<Awaited<ReturnType<typeof findToolAttempt>>>;

export const UNKNOWN_CALL = { result: "Unknown call. End politely and say my manager will follow up." };

/** Returns the JSON body for the tool result, or null for an unknown tool name. */
export async function runAgentTool(attempt: ToolAttempt, name: string | undefined, a: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  switch (name) {
    case "lookup_approved_answer": {
      const offer = await getActiveOfferVersion(attempt.lead.campaign.offerId);
      const q = String(a.question ?? "").slice(0, 1000);
      const r = answerQuestion(q, offer?.factsParsed ?? []);
      if (r.kind === "answer") {
        await applyAgentAction(attempt.id, { type: "offer_discussed", factKeys: r.facts.map((f) => f.key) });
        return { result: `APPROVED ANSWER (say exactly): ${r.facts.map((f) => f.content).join(" ")}` };
      }
      await applyAgentAction(attempt.id, { type: "unanswered_question", question: q, reason: r.kind });
      return { result: 'NO APPROVED ANSWER. Say: "About that, my manager will contact you with the details." Then offer: "If you want, I can have my manager contact you."' };
    }
    case "record_screening_answer":
      return applyAgentAction(attempt.id, { type: "record_slot", ...a });
    case "opt_out":
      return applyAgentAction(attempt.id, { type: "opt_out", raw: String(a.raw ?? "") });
    case "request_human": {
      const r = await applyAgentAction(attempt.id, { type: "request_transfer", reason: a.reason ?? "HUMAN_REQUESTED" });
      const tab = await tabRecruiterPhone(attempt.leadId);
      const s = tab ? null : await db.user.findFirst({ where: { orgId: attempt.lead.orgId, availableForTransfer: true, transferPhoneE164: { not: null } } });
      return { ...r, transfer_number: r.transfer === "pending" ? (tab?.phone ?? s?.transferPhoneE164) : undefined, say: r.transfer === "pending" ? "Tell the driver you're connecting them to your manager." : "Say your manager isn't available right now and will contact them; ask for a good time." };
    }
    case "flag_for_recruiter":
      return applyAgentAction(attempt.id, { type: "flag_handoff", reason: a.reason, note: String(a.note ?? "") });
    case "schedule_callback":
      return applyAgentAction(attempt.id, { type: "schedule_callback", at: a.at || null, raw: String(a.raw ?? "") });
    case "send_cdl_upload_link":
      return applyAgentAction(attempt.id, { type: "send_cdl_link" });
    case "set_call_outcome":
      return applyAgentAction(attempt.id, { type: "set_outcome", outcome: a.outcome });
    default:
      return null;
  }
}
