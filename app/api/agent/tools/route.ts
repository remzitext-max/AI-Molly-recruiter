import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { verifyRetellSignature } from "@/adapters/live/retell";
import { applyAgentAction } from "@/lib/calls";
import { answerQuestion, getActiveOfferVersion } from "@/lib/knowledge";

// Restricted tool endpoint for the managed voice agent. Only the named tools
// exist; arguments are validated by applyAgentAction's closed schema.
export async function POST(req: Request) {
  const raw = await req.text();
  const key = config.retell.apiKey;
  if (!key || !verifyRetellSignature(raw, req.headers.get("x-retell-signature"), key)) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  const body = JSON.parse(raw) as { name?: string; call?: { call_id?: string; metadata?: { attempt_id?: string } }; args?: Record<string, unknown> };
  const attempt = await db.callAttempt.findFirst({ where: { OR: [{ providerCallId: body.call?.call_id ?? "-" }, { id: body.call?.metadata?.attempt_id ?? "-" }] }, include: { lead: { include: { campaign: true } } } });
  if (!attempt) return NextResponse.json({ result: "Unknown call. End politely and say my manager will follow up." });
  const a = body.args ?? {};
  switch (body.name) {
    case "lookup_approved_answer": {
      const offer = await getActiveOfferVersion(attempt.lead.campaign.offerId);
      const q = String(a.question ?? "").slice(0, 1000);
      const r = answerQuestion(q, offer?.factsParsed ?? []);
      if (r.kind === "answer") {
        await applyAgentAction(attempt.id, { type: "offer_discussed", factKeys: r.facts.map((f) => f.key) });
        return NextResponse.json({ result: `APPROVED ANSWER (say exactly): ${r.facts.map((f) => f.content).join(" ")}` });
      }
      await applyAgentAction(attempt.id, { type: "unanswered_question", question: q, reason: r.kind });
      return NextResponse.json({ result: 'NO APPROVED ANSWER. Say: "About that, my manager will contact you with the details." Then offer: "If you want, I can have my manager contact you."' });
    }
    case "record_screening_answer":
      return NextResponse.json(await applyAgentAction(attempt.id, { type: "record_slot", ...a }));
    case "opt_out":
      return NextResponse.json(await applyAgentAction(attempt.id, { type: "opt_out", raw: String(a.raw ?? "") }));
    case "request_human": {
      const r = await applyAgentAction(attempt.id, { type: "request_transfer", reason: a.reason ?? "HUMAN_REQUESTED" });
      const s = await db.user.findFirst({ where: { orgId: attempt.lead.orgId, availableForTransfer: true, transferPhoneE164: { not: null } } });
      return NextResponse.json({ ...r, transfer_number: r.transfer === "pending" ? s?.transferPhoneE164 : undefined, say: r.transfer === "pending" ? "Tell the driver you're connecting them to your manager." : "Say your manager isn't available right now and will contact them; ask for a good time." });
    }
    case "flag_for_recruiter":
      return NextResponse.json(await applyAgentAction(attempt.id, { type: "flag_handoff", reason: a.reason, note: String(a.note ?? "") }));
    case "schedule_callback":
      return NextResponse.json(await applyAgentAction(attempt.id, { type: "schedule_callback", at: a.at ?? null, raw: String(a.raw ?? "") }));
    case "send_cdl_upload_link":
      return NextResponse.json(await applyAgentAction(attempt.id, { type: "send_cdl_link" }));
    case "set_call_outcome":
      return NextResponse.json(await applyAgentAction(attempt.id, { type: "set_outcome", outcome: a.outcome }));
    default:
      return NextResponse.json({ error: "unknown tool" }, { status: 400 });
  }
}
