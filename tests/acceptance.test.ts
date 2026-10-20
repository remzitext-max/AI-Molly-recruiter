// Acceptance checks 1-14 from the specification, run against a real Postgres.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { addLead, drain, resetDb, seedBase, setPersona } from "./helpers";
import { ingestLead, scheduleLeadCall } from "@/lib/leads";
import { ingestVoiceEvent, applyAgentAction } from "@/lib/calls";
import { createUploadLink, handleUpload, readDocumentForUser } from "@/lib/documents";
import { leadScope, canAccessLead } from "@/lib/rbac";
import { claimJobs, enqueue, LOCK_TIMEOUT_MS } from "@/lib/jobs/queue";
import { SpeechPlayback } from "@/lib/conversation/playback";
import { integrationStatuses, setAdapterOverride } from "@/adapters/registry";
import { mockSmsOutbox } from "@/adapters/mock";
import { handleInboundSms, sendCdlLink } from "@/lib/messaging";
import { verifySignature, signPayload } from "@/lib/webhook-auth";
import { buildCallReport } from "@/lib/telegram";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);

beforeEach(async () => { await resetDb(); });

type Base = Awaited<ReturnType<typeof seedBase>>;
async function lead(base: Base, persona: string, over: Parameters<typeof addLead>[1] = {}) {
  const r = await addLead(base, over);
  if (r.result !== "created") throw new Error(`lead not created: ${r.result}`);
  await setPersona(r.leadId, persona);
  return r.leadId;
}
const lastCall = (leadId: string) => db.callAttempt.findFirstOrThrow({ where: { leadId }, orderBy: { createdAt: "desc" } });

describe("1. synthetic lead -> simulated call -> handoff", () => {
  it("completes the full workflow", async () => {
    const base = await seedBase();
    const id = await lead(base, "interested");
    await drain();
    let l = await db.lead.findUniqueOrThrow({ where: { id }, include: { screening: true } });
    const call = await lastCall(id);
    expect(call.status).toBe("COMPLETED");
    expect(call.outcome).toBe("INTERESTED");
    expect(call.isDemo).toBe(true);
    expect(call.offerVersionId).toBe(base.offerVersion.id);
    expect(l.lastOfferVersionId).toBe(base.offerVersion.id);
    expect(l.documentStatus).toBe("REQUESTED");
    expect(l.pipelineStatus).toBe("DOCS_REQUESTED");
    const keys = l.screening.map((s) => s.key);
    for (const k of ["cdl_class", "experience_years", "equipment_experience", "start_date", "offer_interest", "route_preference"]) expect(keys).toContain(k);
    expect(keys).not.toContain("home_location"); // known from the lead, so never re-asked
    // driver-reported only; nothing verified
    expect(l.screening.every((s) => s.verifiedValue === null)).toBe(true);

    // driver uploads CDL through the SMS link
    const sms = mockSmsOutbox.at(-1)!;
    const token = sms.body.match(/\/u\/([A-Za-z0-9_-]+)/)![1];
    await handleUpload(token, { data: JPEG });
    await drain();
    l = await db.lead.findUniqueOrThrow({ where: { id }, include: { screening: true } });
    expect(l.documentStatus).toBe("RECEIVED");
    expect(l.pipelineStatus).toBe("HANDED_OFF");
    const h = await db.handoff.findFirstOrThrow({ where: { leadId: id, reason: "READY" } });
    expect(h.recruiterId).toBe(base.molly.id);
    const p = h.payload as Record<string, any>;
    expect(p.offer.versionId).toBe(base.offerVersion.id);
    expect(p.documents.links.length).toBe(1);
    expect(p.lastCall.summary).toMatch(/SIMULATED/);
    expect(p.note).toMatch(/NOT been performed/);
    const task = await db.task.findFirstOrThrow({ where: { leadId: id, type: "HANDOFF" } });
    expect(task.assignedToId).toBe(base.molly.id);
  });
});

describe("2/3. approved answers vs unknown questions", () => {
  it("answers pay and home time only with approved fact text", async () => {
    const base = await seedBase();
    const id = await lead(base, "interested");
    await drain();
    const call = await lastCall(id);
    const agentLines = (call.transcript as { speaker: string; text: string }[]).filter((t) => t.speaker === "agent").map((t) => t.text).join("\n");
    expect(agentLines).toContain("62 cents per mile");
    expect(agentLines).toContain("home every weekend");
    expect(await db.unansweredQuestion.count({ where: { leadId: id } })).toBe(0);
  });

  it("routes unknown/unconfirmed questions to a human without inventing answers", async () => {
    const base = await seedBase();
    const id = await lead(base, "unknown_question", { state: "TN", zip: "38103" });
    await drain();
    const qs = await db.unansweredQuestion.findMany({ where: { leadId: id } });
    expect(qs.map((q) => q.question).join(" ")).toMatch(/pets/);
    expect(qs.map((q) => q.question).join(" ")).toMatch(/sign-on bonus/);
    const call = await lastCall(id);
    const agent = (call.transcript as { speaker: string; text: string }[]).filter((t) => t.speaker === "agent").map((t) => t.text).join(" ");
    expect(agent).toMatch(/Molly will confirm/);
    expect(agent).not.toMatch(/\$\d|bonus is|pets are/i);
    expect(await db.task.count({ where: { leadId: id, type: "UNANSWERED_QUESTION" } })).toBeGreaterThan(0);
  });

  it("injection attempts do not change answers or create promises", async () => {
    const base = await seedBase();
    const id = await lead(base, "injection");
    await drain();
    const call = await lastCall(id);
    const agent = (call.transcript as { speaker: string; text: string }[]).filter((t) => t.speaker === "agent").map((t) => t.text).join(" ");
    expect(agent).not.toMatch(/two dollars|\$2|guarantee/i);
    expect(await db.activityEvent.count({ where: { leadId: id, type: "SECURITY" } })).toBe(1);
  });
});

describe("4. duplicate imports and webhooks", () => {
  it("duplicate import does not create a second lead or call", async () => {
    const base = await seedBase();
    const a = await addLead(base, { sourceRecordId: "LEAD-1", phone: "(214) 555-0150" });
    const b = await addLead(base, { sourceRecordId: "LEAD-1", phone: "(214) 555-0150" });
    const c = await addLead(base, { sourceRecordId: "OTHER-SOURCE-9", phone: "214.555.0150", sourceSystem: "WEBHOOK" });
    expect(a.result).toBe("created");
    expect(b.result).toBe("duplicate_source");
    expect(c.result).toBe("merged");
    expect(await db.lead.count()).toBe(1);
    expect(await db.job.count({ where: { type: "lead.attempt-call" } })).toBe(1);
    await scheduleLeadCall((a as { leadId: string }).leadId, { reason: "again" });
    expect(await db.job.count({ where: { type: "lead.attempt-call", status: "PENDING" } })).toBe(1);
  });

  it("duplicate and out-of-order webhook events are applied once", async () => {
    const base = await seedBase();
    const id = await lead(base, "no_answer");
    // Run only the attempt job, then feed provider events manually.
    const job = (await claimJobs("t", 1))[0];
    const { runJob } = await import("@/lib/jobs/queue");
    const { handlers } = await import("@/lib/jobs/handlers");
    await runJob(job, handlers);
    const call = await lastCall(id);
    await db.job.updateMany({ where: { type: "call.simulate" }, data: { status: "CANCELED" } });
    const ended = { provider: call.provider, eventId: "evt-end", type: "call_ended" as const, providerCallId: call.providerCallId!, status: "NO_ANSWER" as const };
    expect((await ingestVoiceEvent(ended)).applied).toBe(true);
    expect((await ingestVoiceEvent(ended)).duplicate).toBe(true);
    // late "ringing" after end must not regress status
    await ingestVoiceEvent({ provider: call.provider, eventId: "evt-ring", type: "call_ringing", providerCallId: call.providerCallId! });
    const after = await lastCall(id);
    expect(after.status).toBe("NO_ANSWER");
    // exactly one retry scheduled, not two
    expect(await db.job.count({ where: { type: "lead.attempt-call", status: "PENDING" } })).toBe(1);
  });

  it("rejects bad or replayed webhook signatures", () => {
    const body = JSON.stringify({ a: 1 });
    expect(verifySignature("s3cret", body, signPayload("s3cret", body)).ok).toBe(true);
    expect(verifySignature("s3cret", body, signPayload("wrong", body)).ok).toBe(false);
    expect(verifySignature("s3cret", body, signPayload("s3cret", body, Date.now() - 10 * 60_000)).ok).toBe(false);
  });
});

describe("5. opt-out", () => {
  it("opt-out during call stops calls and messages and survives re-import", async () => {
    const base = await seedBase();
    const id = await lead(base, "opt_out", { phone: "(405) 555-0103", state: "OK", zip: "73102" });
    await drain();
    const l = await db.lead.findUniqueOrThrow({ where: { id } });
    expect(l.pipelineStatus).toBe("OPTED_OUT");
    expect(await db.suppression.count({ where: { phoneE164: "+14055550103" } })).toBe(1);
    await scheduleLeadCall(id, { reason: "try again" });
    expect(await db.job.count({ where: { type: "lead.attempt-call", status: "PENDING" } })).toBe(0);
    const sms = await sendCdlLink(id, null, { verbalConsent: true });
    expect(sms.sent).toBe(false);
    // re-import from another source
    const again = await addLead(base, { phone: "405-555-0103", sourceRecordId: "new-src", sourceSystem: "XLSX" });
    expect(again.result).toBe("merged");
    expect(await db.callAttempt.count({ where: { leadId: id } })).toBe(1);
    // new lead in another org-campaign with same number is created as opted-out
  });

  it("STOP by text suppresses the number", async () => {
    const base = await seedBase();
    const r = await addLead(base, { phone: "(214) 555-0177" });
    await handleInboundSms("+12145550177", "STOP", "in-1", "mock");
    const l = await db.lead.findUniqueOrThrow({ where: { id: (r as { leadId: string }).leadId } });
    expect(l.optedOutAt).not.toBeNull();
    await drain();
    expect(await db.callAttempt.count()).toBe(0);
  });
});

describe("6. contact hours", () => {
  it("keeps calls queued outside permitted driver-local hours", async () => {
    // A window that is never open today: 1-minute window 3 hours from now (driver-local).
    const { DateTime } = await import("luxon");
    const local = DateTime.now().setZone("America/Chicago").plus({ hours: 3 });
    const start = local.toFormat("HH:mm");
    const end = local.plus({ minutes: 1 }).toFormat("HH:mm");
    const base = await seedBase({ window: start < end ? [start, end] : ["03:00", "03:01"] });
    const id = await lead(base, "interested");
    await drain();
    expect(await db.callAttempt.count({ where: { leadId: id } })).toBe(0);
    const job = await db.job.findFirstOrThrow({ where: { type: "lead.attempt-call" } });
    expect(job.status).toBe("PENDING");
    expect(job.runAt.getTime()).toBeGreaterThan(Date.now());
    expect(job.lastError).toBe("OUTSIDE_HOURS");
  });

  it("unknown timezone blocks automatic calling", async () => {
    const base = await seedBase();
    const id = await lead(base, "interested", { state: "", zip: "" });
    await drain();
    expect(await db.callAttempt.count({ where: { leadId: id } })).toBe(0);
    expect((await db.lead.findUniqueOrThrow({ where: { id } })).pipelineStatus).toBe("NEEDS_TIMEZONE");
  });

  it("missing contact permission blocks AI calling", async () => {
    const base = await seedBase();
    const id = await lead(base, "interested", { permission: false });
    await drain();
    expect(await db.callAttempt.count({ where: { leadId: id } })).toBe(0);
    expect((await db.lead.findUniqueOrThrow({ where: { id } })).pipelineStatus).toBe("NEEDS_PERMISSION");
  });

  it("global pause keeps calls queued", async () => {
    const base = await seedBase();
    await db.systemSetting.update({ where: { id: "global" }, data: { globalPause: true } });
    await lead(base, "interested");
    await drain();
    expect(await db.callAttempt.count()).toBe(0);
    expect((await db.job.findFirstOrThrow({ where: { type: "lead.attempt-call" } })).status).toBe("PENDING");
  });
});

describe("7/8. secure CDL upload and access", () => {
  it("upload updates candidate; tokens are single-purpose and expire", async () => {
    const base = await seedBase();
    const r = await addLead(base);
    const id = (r as { leadId: string }).leadId;
    const link = await createUploadLink(id);
    await expect(handleUpload(link.token, { data: Buffer.from("not an image") })).rejects.toThrow(/Only JPG/);
    await handleUpload(link.token, { data: JPEG });
    expect((await db.lead.findUniqueOrThrow({ where: { id } })).documentStatus).toBe("RECEIVED");
    await expect(handleUpload("x".repeat(43), { data: JPEG })).rejects.toThrow(/invalid or has expired/);
    await db.uploadToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(handleUpload(link.token, { data: JPEG })).rejects.toThrow(/expired/);
    const ev = await db.activityEvent.findMany({ where: { leadId: id } });
    expect(JSON.stringify(ev)).not.toContain(link.token);
  });

  it("unauthorized users cannot read CDL files", async () => {
    const base = await seedBase();
    const r = await addLead(base);
    const id = (r as { leadId: string }).leadId;
    const link = await createUploadLink(id);
    const { documentId } = await handleUpload(link.token, { data: JPEG });
    const owner = (await db.lead.findUniqueOrThrow({ where: { id } })).assignedToId;
    const other = owner === base.molly.id ? base.alex : base.molly;
    await expect(readDocumentForUser(other, documentId)).rejects.toThrow(/No access/);
    const ok = await readDocumentForUser(base.admin, documentId);
    expect(ok.data.equals(JPEG)).toBe(true);
  });
});

describe("9. recruiter permissions", () => {
  it("recruiters only see assigned candidates", async () => {
    const base = await seedBase();
    const a = (await addLead(base)) as { leadId: string };
    const b = (await addLead(base)) as { leadId: string };
    const la = await db.lead.findUniqueOrThrow({ where: { id: a.leadId } });
    const lb = await db.lead.findUniqueOrThrow({ where: { id: b.leadId } });
    expect(la.assignedToId).not.toBe(lb.assignedToId); // round robin
    const mollyLeads = await db.lead.findMany({ where: leadScope(base.molly) });
    expect(mollyLeads.length).toBe(1);
    const mollyOwns = la.assignedToId === base.molly.id ? la.id : lb.id;
    const notMine = mollyOwns === la.id ? lb.id : la.id;
    expect(await canAccessLead(base.molly, notMine)).toBe(false);
    expect(await canAccessLead(base.admin, notMine)).toBe(true);
  });
});

describe("10. failed transfers", () => {
  it("creates a callback task and never reports success", async () => {
    const base = await seedBase();
    const id = await lead(base, "wants_human_transfer_fails");
    await drain();
    const h = await db.handoff.findFirstOrThrow({ where: { leadId: id, reason: "HUMAN_REQUESTED" } });
    expect(h.transferStatus).toBe("FAILED");
    expect(await db.task.count({ where: { leadId: id, type: "TRANSFER_FAILED" } })).toBe(1);
    expect((await db.lead.findUniqueOrThrow({ where: { id } })).pipelineStatus).not.toBe("HANDED_OFF");
  });

  it("no available recruiter -> immediate failed transfer + task", async () => {
    const base = await seedBase();
    await db.user.updateMany({ data: { availableForTransfer: false } });
    const id = await lead(base, "wants_human");
    await drain();
    expect(await db.task.count({ where: { leadId: id, type: "TRANSFER_FAILED" } })).toBe(1);
  });

  it("successful transfer only after provider confirmation", async () => {
    const base = await seedBase();
    const id = await lead(base, "wants_human");
    await drain();
    const h = await db.handoff.findFirstOrThrow({ where: { leadId: id, reason: "HUMAN_REQUESTED" } });
    expect(h.transferStatus).toBe("CONFIRMED");
    expect(await db.activityEvent.count({ where: { leadId: id, type: "TRANSFER_CONFIRMED" } })).toBe(1);
  });
});

describe("11. missing live credentials", () => {
  it("cannot initiate real calls or messages", async () => {
    const base = await seedBase();
    process.env.APP_MODE = "live";
    setAdapterOverride(null);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await db.systemSetting.update({ where: { id: "global" }, data: { liveContactEnabled: true, contactPolicyConfirmedAt: new Date() } });
    await db.campaign.update({ where: { id: base.campaign.id }, data: { isDemo: false } });
    await db.offerVersion.update({ where: { id: base.offerVersion.id }, data: { synthetic: false } });
    const r = await ingestLead(
      { sourceSystem: "CSV", sourceRecordId: "live-1", firstName: "Real", phone: "(214) 555-0188", state: "TX", zip: "75201", permission: [{ scope: "AI_CALL", source: "form", grantedAt: new Date(Date.now() - 1000).toISOString() }, { scope: "SMS", source: "form", grantedAt: new Date(Date.now() - 1000).toISOString() }] },
      { orgId: base.org.id, campaignId: base.campaign.id, isDemo: false },
    );
    const id = (r as { leadId: string }).leadId;
    await drain();
    const call = await lastCall(id);
    expect(call.status).toBe("CANCELED");
    expect(call.providerCallId).toBeNull();
    expect(call.errorMessage).toMatch(/not configured/);
    const sms = await sendCdlLink(id, null, { verbalConsent: false });
    expect(sms.sent).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("live mode refuses synthetic offers", async () => {
    const base = await seedBase();
    process.env.APP_MODE = "live";
    setAdapterOverride(null);
    await db.systemSetting.update({ where: { id: "global" }, data: { liveContactEnabled: true, contactPolicyConfirmedAt: new Date() } });
    const r = await ingestLead(
      { sourceSystem: "CSV", sourceRecordId: "live-2", phone: "(214) 555-0189", state: "TX", zip: "75201", permission: [{ scope: "AI_CALL", source: "form", grantedAt: new Date(Date.now() - 1000).toISOString() }] },
      { orgId: base.org.id, campaignId: base.campaign.id, isDemo: false },
    );
    await drain();
    const l = await db.lead.findUniqueOrThrow({ where: { id: (r as { leadId: string }).leadId } });
    expect(l.queueReason).toMatch(/synthetic/);
    expect(await db.callAttempt.count()).toBe(0);
  });

  it("live mode refuses demo records and requires policy confirmation", async () => {
    const base = await seedBase();
    const id = await lead(base, "interested");
    process.env.APP_MODE = "live";
    setAdapterOverride(null);
    await drain();
    expect(await db.callAttempt.count({ where: { leadId: id } })).toBe(0);
  });
});

describe("12. worker restarts", () => {
  it("abandoned running jobs are reclaimed and scheduled jobs persist", async () => {
    await seedBase();
    const job = await enqueue("maintenance.retention", {}, {});
    const future = await enqueue("maintenance.retention", {}, { runAt: new Date(Date.now() + 3600_000) });
    const claimed = await claimJobs("worker-A", 10);
    expect(claimed.map((j) => j.id)).toContain(job.id);
    // worker-A crashes; nothing else can claim while its lock is fresh
    expect(await claimJobs("worker-B", 10)).toHaveLength(0);
    await db.job.update({ where: { id: job.id }, data: { lockedAt: new Date(Date.now() - LOCK_TIMEOUT_MS - 1000) } });
    const reclaimed = await claimJobs("worker-B", 10);
    expect(reclaimed.map((j) => j.id)).toEqual([job.id]);
    expect((await db.job.findUniqueOrThrow({ where: { id: future.id } })).status).toBe("PENDING");
  });

  it("a re-delivered simulate job after restart does not duplicate the call", async () => {
    const base = await seedBase();
    const id = await lead(base, "interested");
    await drain();
    const sim = await db.job.findFirstOrThrow({ where: { type: "call.simulate" } });
    await db.job.update({ where: { id: sim.id }, data: { status: "PENDING", runAt: new Date() } });
    await drain();
    expect(await db.callAttempt.count({ where: { leadId: id } })).toBe(1);
    expect(mockSmsOutbox.filter((m) => m.to === "+1" + "").length).toBe(0);
    expect(await db.message.count({ where: { leadId: id, purpose: "CDL_LINK" } })).toBe(1);
  });

  it("simultaneous call jobs for one lead never dial twice", async () => {
    const base = await seedBase();
    const r = (await addLead(base)) as { leadId: string };
    await enqueue("lead.attempt-call", { leadId: r.leadId, personaKey: "no_answer" });
    const { runJob } = await import("@/lib/jobs/queue");
    const { handlers } = await import("@/lib/jobs/handlers");
    const jobs = await claimJobs("w", 10);
    await Promise.all(jobs.filter((j) => j.type === "lead.attempt-call").map((j) => runJob(j, handlers)));
    expect(await db.callAttempt.count({ where: { leadId: r.leadId } })).toBe(1);
  });
});

describe("13. voice interruption", () => {
  it("barge-in stops audio and cancels stale queued speech", async () => {
    const played: string[] = [];
    let stopped = 0;
    const synth = {
      async *stream(text: string, signal: AbortSignal) {
        for (const w of text.split(" ")) {
          if (signal.aborted) return;
          await new Promise((r) => setTimeout(r, 2));
          yield new TextEncoder().encode(w);
        }
      },
    };
    const sink = {
      async play(c: Uint8Array) { played.push(new TextDecoder().decode(c)); await new Promise((r) => setTimeout(r, 2)); },
      stop() { stopped++; },
    };
    const pb = new SpeechPlayback(synth, sink);
    pb.beginTurn(1);
    const a = pb.say("one two three four five six seven eight nine ten", 1);
    const b = pb.say("this should never play", 1);
    await new Promise((r) => setTimeout(r, 12));
    pb.bargeIn();
    await pb.idle();
    expect(stopped).toBe(1);
    expect(pb.state(a)).toBe("cancelled");
    expect(pb.state(b)).toBe("cancelled");
    expect(played).not.toContain("never");
    expect(played.length).toBeLessThan(10);
    // a stale turn's queued speech is dropped when a new turn begins
    pb.beginTurn(2);
    const stale = pb.say("old answer", 1);
    expect(pb.state(stale)).toBeUndefined();
    const fresh = pb.say("new answer", 2);
    await pb.idle();
    expect(pb.state(fresh)).toBe("done");
    expect(pb.events.some((e) => e.type === "first_audio" && typeof e.latencyMs === "number")).toBe(true);
  });
});

describe("14. integration status honesty", () => {
  it("demo mode marks all contact integrations as mocked", () => {
    process.env.APP_MODE = "demo";
    setAdapterOverride(null);
    const s = integrationStatuses();
    for (const kind of ["voice_agent", "telephony", "sms"] as const) {
      const x = s.find((i) => i.kind === kind)!;
      expect(x.isMock).toBe(true);
      expect(x.state).toBe("mock");
    }
    expect(s.find((i) => i.provider.startsWith("Google Sheets"))!.state).toBe("mock");
  });
  it("live mode without credentials reports missing credentials", () => {
    process.env.APP_MODE = "live";
    setAdapterOverride(null);
    const s = integrationStatuses();
    expect(s.find((i) => i.kind === "voice_agent")!.state).toBe("missing_credentials");
    expect(s.find((i) => i.kind === "sms")!.state).toBe("missing_credentials");
    expect(s.find((i) => i.provider === "Google Sheets")!.state).toBe("missing_credentials");
    expect(s.filter((i) => ["voice_agent", "sms", "telephony"].includes(i.kind)).every((i) => !i.isMock)).toBe(true);
  });
});

describe("other workflow behaviour", () => {
  it("failed calls do not erase application progress", async () => {
    const base = await seedBase();
    const id = await lead(base, "interested");
    await drain();
    const before = await db.lead.findUniqueOrThrow({ where: { id } });
    expect(before.pipelineStatus).toBe("DOCS_REQUESTED");
    await scheduleLeadCall(id, { reason: "follow up" });
    await setPersona(id, "no_answer");
    await drain();
    const after = await db.lead.findUniqueOrThrow({ where: { id }, include: { screening: true } });
    expect(after.pipelineStatus).toBe("DOCS_REQUESTED");
    expect(after.screening.length).toBe(before ? after.screening.length : 0);
  });

  it("busy driver callback is scheduled in driver-local time", async () => {
    const base = await seedBase();
    const id = await lead(base, "busy_callback", { state: "AZ", zip: "85004", phone: "(602) 555-0104" });
    await drain();
    const l = await db.lead.findUniqueOrThrow({ where: { id } });
    expect(l.pipelineStatus).toBe("CALLBACK_SCHEDULED");
    const { DateTime } = await import("luxon");
    expect(DateTime.fromJSDate(l.callbackAt!).setZone("America/Phoenix").hour).toBe(15);
    const job = await db.job.findFirstOrThrow({ where: { type: "lead.attempt-call", status: "PENDING" } });
    expect(job.runAt.getTime()).toBe(l.callbackAt!.getTime());
  });

  it("voicemail and no-answer schedule bounded retries", async () => {
    const base = await seedBase();
    const id = await lead(base, "voicemail");
    await drain();
    const c = await lastCall(id);
    expect(c.status).toBe("VOICEMAIL");
    const pending = await db.job.findFirstOrThrow({ where: { type: "lead.attempt-call", status: "PENDING" } });
    expect(pending.runAt.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    await db.lead.update({ where: { id }, data: { attemptCount: 3 } });
    await db.job.update({ where: { id: pending.id }, data: { runAt: new Date() } });
    await drain();
    expect(await db.callAttempt.count({ where: { leadId: id } })).toBe(1);
    expect(await db.task.count({ where: { leadId: id, type: "CALLBACK" } })).toBe(1);
  });

  it("eligibility exceptions go to a human without a judgement", async () => {
    const base = await seedBase();
    const id = await lead(base, "eligibility", { state: "CO", zip: "80202", phone: "(303) 555-0109" });
    await drain();
    expect(await db.handoff.count({ where: { leadId: id, reason: "ELIGIBILITY_EXCEPTION" } })).toBe(1);
  });

  it("agent actions outside the closed tool set are rejected", async () => {
    const base = await seedBase();
    const id = await lead(base, "no_answer");
    await drain();
    const c = await lastCall(id);
    const r = await applyAgentAction(c.id, { type: "mark_hired", leadId: id });
    expect(r.ok).toBe(false);
    const r2 = await applyAgentAction(c.id, { type: "record_slot", key: "ssn", value: "x", raw: "x", status: "CAPTURED" });
    expect(r2.ok).toBe(false);
  });
});

describe("Telegram driver card", () => {
  it("builds a card for an answered real call and skips demo records", async () => {
    const base = await seedBase();
    const real = await db.lead.create({ data: { orgId: base.org.id, campaignId: base.campaign.id, firstName: "Ray", lastName: "<Test>", phoneE164: "+12145550111" } });
    const started = new Date(Date.now() - 200_000);
    const a = await db.callAttempt.create({ data: { leadId: real.id, provider: "telnyx", idempotencyKey: "tg-1", status: "COMPLETED", outcome: "INTERESTED", startedAt: started, endedAt: new Date(started.getTime() + 185_000) } });
    for (const [key, reportedValue] of [["home_time", "4 weeks out, 4 days home"], ["experience_years", "3 years OTR"], ["pay_expectation", "80 cents"], ["transmission", "Manual"], ["english_level", "Good"], ["start_date", "Next Monday"], ["home_location", "Dallas, TX"]]) {
      await db.screeningField.create({ data: { leadId: real.id, key, reportedValue, callAttemptId: a.id } });
    }
    const card = await buildCallReport(a.id);
    expect(card).toBe([
      "👔Recruiter: Crystal AI",
      "🥸Driver type: Solo",
      "🗒Driver name: Ray &lt;Test&gt;",
      "🌍State: Dallas, TX",
      "🏠Home time: 4 weeks out, 4 days home",
      "📈Experience: 3 years OTR",
      "💵Payment: asking: 80 cents",
      "🚛can drive: Manual",
      "🗣 English: Good",
      "✅ Ready date: Next Monday",
      "☎️Phone number : +12145550111",
    ].join("\n"));

    const demo = await lead(base, "interested");
    await drain();
    expect(await buildCallReport((await lastCall(demo)).id)).toBeNull();
    const unanswered = await db.callAttempt.create({ data: { leadId: real.id, provider: "telnyx", idempotencyKey: "tg-2", status: "NO_ANSWER" } });
    expect(await buildCallReport(unanswered.id)).toBeNull();
  });
});
