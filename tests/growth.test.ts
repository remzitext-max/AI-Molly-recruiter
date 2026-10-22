import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { addLead, drain, resetDb, seedBase, setPersona } from "./helpers";
import { experienceMonths, fitScore, fitText } from "@/lib/fit-score";
import { reengageScan } from "@/lib/reengage";
import { readDocument, nameMatches } from "@/lib/document-read";
import { parseDocFields } from "@/adapters/live/telnyx-vision";
import { setAdapterOverride } from "@/adapters/registry";
import { MockExtractor } from "@/adapters/mock";
import { sendMetaStageEvent, syncMetaLeads } from "@/lib/meta";
import { getAdapters } from "@/adapters/registry";
import type { DocumentExtractor } from "@/adapters/types";
import { commitBatch, createImportPreview } from "@/lib/import";

beforeEach(async () => { await resetDb(); });

describe("fit score", () => {
  it("reads experience the way drivers say it", () => {
    expect(experienceMonths("2+years")).toBe(24);
    expect(experienceMonths("6+ months")).toBe(6);
    expect(experienceMonths("a year and a half")).toBe(18);
    expect(experienceMonths("3 years 6 months")).toBe(42);
    expect(experienceMonths("5")).toBe(60);
    expect(experienceMonths("just got my CDL")).toBe(0);
    expect(experienceMonths("OTR mostly")).toBeNull();
  });

  it("knocks out on the company's requirements and explains why", () => {
    const strong = fitScore({ experience_years: "5 years", sap_history: "No", cdl_class: "Class A", accidents_at_fault: "no", english_level: "Good" });
    expect(strong).toMatchObject({ score: 100, label: "Strong fit", knockout: false });
    const sap = fitScore({ experience_years: "5 years", sap_history: "yes, finished it", cdl_class: "A" });
    expect(sap.knockout).toBe(true);
    expect(sap.reasons).toContain("SAP history");
    const junior = fitScore({ experience_years: "6+ months", sap_history: "no", cdl_class: "A" });
    expect(junior.label).toBe("Not a fit");
    expect(fitText(junior)).toMatch(/needs 2 yr solo/);
    const team = fitScore({ experience_years: "1 year", driving_type: "Team", sap_history: "no", cdl_class: "A", accidents_at_fault: "no" });
    expect(team.knockout).toBe(false);
    expect(fitScore({ first_name: "Al" }).label).toBe("Not enough answers");
    expect(fitScore({ experience_years: "3 years", sap_history: "no", cdl_class: "A", accidents_at_fault: "yes one in 2023", english_level: "Fair" }).score).toBe(65);
  });
});

describe("missed-call text", () => {
  it("texts once after an unanswered call, never twice", async () => {
    const base = await seedBase();
    await db.systemSetting.update({ where: { id: "global" }, data: { requireSmsPermission: false } });
    const r = await addLead(base);
    if (r.result !== "created") throw new Error("no lead");
    await setPersona(r.leadId, "no_answer");
    await drain();
    const msgs = await db.message.findMany({ where: { leadId: r.leadId, purpose: "MISSED_CALL" } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toBe("Demo Freight recruiting team: Hi Marcus, it's Crystal. We just tried to call you about the truck driving job you applied for. When is a good time to call you back? Reply STOP to opt out.");
    // Second missed call: no second text.
    const job = await db.job.findFirstOrThrow({ where: { type: "lead.attempt-call", status: "PENDING" } });
    await db.job.update({ where: { id: job.id }, data: { runAt: new Date(), payload: { leadId: r.leadId, personaKey: "no_answer" } } });
    await drain();
    expect(await db.callAttempt.count({ where: { leadId: r.leadId } })).toBe(2);
    expect(await db.message.count({ where: { leadId: r.leadId, purpose: "MISSED_CALL" } })).toBe(1);
  });

  it("is not sent when switched off", async () => {
    const base = await seedBase();
    await db.systemSetting.update({ where: { id: "global" }, data: { requireSmsPermission: false, missedCallSms: false } });
    const r = await addLead(base);
    if (r.result !== "created") throw new Error("no lead");
    await setPersona(r.leadId, "no_answer");
    await drain();
    expect(await db.message.count({ where: { leadId: r.leadId, purpose: "MISSED_CALL" } })).toBe(0);
  });
});

describe("follow-up round for old leads", () => {
  it("re-queues unreached and not-interested leads once, never stopped or recruiter-worked ones", async () => {
    const base = await seedBase();
    await db.campaign.update({ where: { id: base.campaign.id }, data: { reengageAfterDays: 30 } });
    const old = new Date(Date.now() - 40 * 86400_000);
    const mk = async (data: Record<string, unknown>) => {
      const r = await addLead(base);
      if (r.result !== "created") throw new Error("no lead");
      await db.job.deleteMany({ where: { payload: { path: ["leadId"], equals: r.leadId } } });
      await db.lead.update({ where: { id: r.leadId }, data });
      await db.callAttempt.create({ data: { leadId: r.leadId, isDemo: true, provider: "mock", idempotencyKey: `old-${r.leadId}`, status: "NO_ANSWER", createdAt: old } });
      return r.leadId;
    };
    const unreached = await mk({ attemptCount: 3, pipelineStatus: "QUEUED", queueReason: "Max AI call attempts reached" });
    const saidNo = await mk({ attemptCount: 1, pipelineStatus: "NOT_INTERESTED" });
    const stopped = await mk({ attemptCount: 3, pipelineStatus: "CLOSED" });
    const recent = await mk({ attemptCount: 3, pipelineStatus: "QUEUED" });
    await db.callAttempt.create({ data: { leadId: recent, isDemo: true, provider: "mock", idempotencyKey: `new-${recent}`, status: "NO_ANSWER" } });
    const hired = await mk({ attemptCount: 3, pipelineStatus: "QUEUED", hireStage: "HIRED" });
    const working = await mk({ attemptCount: 3, pipelineStatus: "QUEUED" });
    const w = await db.lead.findUniqueOrThrow({ where: { id: working } });
    await db.metaSheetEvent.create({ data: { phoneE164: w.phoneE164, eventName: "Interested", tab: "Molly", status: "Call back" } });

    expect(await reengageScan()).toEqual({ queued: 2 });
    for (const id of [unreached, saidNo]) {
      const l = await db.lead.findUniqueOrThrow({ where: { id } });
      expect(l.reengagedAt).not.toBeNull();
      expect(l.attemptCount).toBe(1);
      expect(await db.job.count({ where: { type: "lead.attempt-call", status: "PENDING", payload: { path: ["leadId"], equals: id } } })).toBe(1);
    }
    for (const id of [stopped, recent, hired, working]) expect(await db.job.count({ where: { type: "lead.attempt-call", payload: { path: ["leadId"], equals: id } } })).toBe(0);
    expect(await reengageScan()).toEqual({ queued: 0 });
  });
});

describe("reading CDL / medical card photos", () => {
  it("keeps only the last 4 of the license number", () => {
    expect(parseDocFields('Here: {"doc_type":"CDL","license_class":"A","license_last4":"D123 4567 8901","full_name":"MARCUS TEST","expiration_date":"2027-03-01","restrictions":null}')).toEqual({
      doc_type: "CDL", license_class: "A", license_last4: "8901", full_name: "MARCUS TEST", expiration_date: "2027-03-01",
    });
    expect(nameMatches("MARCUS A TEST", { firstName: "Marcus", lastName: "Test" })).toBe(true);
    expect(nameMatches("JOHN DOE", { firstName: "Marcus", lastName: "Test" })).toBe(false);
  });

  it("stores what was read, fills the medical card expiry and flags a wrong name", async () => {
    const base = await seedBase();
    const r = await addLead(base);
    if (r.result !== "created") throw new Error("no lead");
    const reader = new MockExtractor() as unknown as DocumentExtractor;
    reader.extract = async () => ({ docType: "medical card", warnings: ["check it"], fields: [
      { name: "full_name", value: "JOHN DOE", confidence: 0.7, uncertain: true },
      { name: "expiration_date", value: "2027-01-15", confidence: 0.7, uncertain: true },
    ] });
    setAdapterOverride({ extraction: reader });
    const key = `cdl/x/${Date.now()}.jpg`;
    await getAdapters().storage.put(key, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), "image/jpeg");
    const d = await db.document.create({ data: { leadId: r.leadId, isDemo: true, storageKey: key, mimeType: "image/jpeg", sizeBytes: 6, sha256: "x", deleteAfter: new Date(Date.now() + 86400_000) } });
    expect((await readDocument(d.id, new Date("2026-10-21T12:00:00Z"))).read).toBe(true);
    const saved = await db.document.findUniqueOrThrow({ where: { id: d.id } });
    expect(saved.kind).toBe("MED_CARD");
    expect((saved.extraction as { warnings: string[] }).warnings[0]).toMatch(/does not match/);
    const f = await db.screeningField.findUniqueOrThrow({ where: { leadId_key: { leadId: r.leadId, key: "med_card_expiry" } } });
    expect(f.reportedValue).toBe("2027-01-15");
    expect(f.rawUtterance).toBe("(read from medical card photo)");
  });
});

describe("Facebook lead ads", () => {
  const env = { META_ACCESS_TOKEN: "TOKEN", META_PAGE_ID: "PAGE", META_DATASET_ID: "DS" };
  it("matches leads to their campaign by phone and reports stages with the Facebook lead ID", async () => {
    Object.assign(process.env, env);
    const base = await seedBase();
    const r = await addLead(base, { phone: "(214) 555-0177" });
    if (r.result !== "created") throw new Error("no lead");
    await db.lead.update({ where: { id: r.leadId }, data: { isDemo: false } });
    const calls: { url: string; body?: string }[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
      const url = String(u);
      calls.push({ url, body: init?.body as string | undefined });
      if (url.includes("/PAGE/leadgen_forms")) return new Response(JSON.stringify({ data: [{ id: "F1", name: "CDL-A solo form" }] }));
      if (url.includes("/F1/leads")) return new Response(JSON.stringify({ data: [
        { id: "9001", created_time: "2026-10-21T10:00:00+0000", campaign_name: "Solo OTR - Texas", ad_name: "Ad 3", field_data: [{ name: "phone_number", values: ["+12145550177"] }] },
        { id: "9002", created_time: "2026-10-21T10:05:00+0000", campaign_name: "Other", field_data: [{ name: "phone_number", values: ["+13125550100"] }] },
      ] }));
      if (url.includes("/DS/events")) return new Response(JSON.stringify({ events_received: 1 }));
      return new Response("{}");
    });
    try {
      expect(await syncMetaLeads()).toMatchObject({ matched: 1, fetched: 2 });
      const l = await db.lead.findUniqueOrThrow({ where: { id: r.leadId } });
      expect(l).toMatchObject({ fbLeadId: "9001", fbCampaign: "Solo OTR - Texas", fbAd: "Ad 3", fbForm: "CDL-A solo form" });
      await sendMetaStageEvent(r.leadId, "INTERESTED");
      const ev = calls.find((c) => c.url.includes("/DS/events"))!;
      const sent = JSON.parse(ev.body!).data[0];
      expect(sent).toMatchObject({ event_name: "Interested", action_source: "system_generated", user_data: { lead_id: "9001" }, custom_data: { event_source: "crm" } });
      expect(sent.user_data.ph[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(ev.body).not.toContain("2145550177");
    } finally {
      spy.mockRestore();
      for (const k of Object.keys(env)) delete process.env[k];
    }
  });

  it("reads Campaign and FB Lead ID columns from the sheet when Make.com adds them", async () => {
    const base = await seedBase();
    const csv = "Applied,Name,Phone,Source,Campaign,FB Lead ID,Ad name\n2026-10-21,Jean Test,(239) 555-0107,SOLO,Solo OTR - Florida,1234567890,Ad 2\n2026-10-21,No Ad,(239) 555-0108,SOLO,,,\n";
    const b = await createImportPreview({ fileName: "pool.csv", data: Buffer.from(csv), campaignId: base.campaign.id, userId: base.admin.id, orgId: base.org.id, isDemo: true });
    expect((await commitBatch(b.id, base.admin)).created).toBe(2);
    expect(await db.lead.findFirstOrThrow({ where: { phoneE164: "+12395550107" } })).toMatchObject({ fbLeadId: "1234567890", fbCampaign: "Solo OTR - Florida", fbAd: "Ad 2", fbForm: null });
    expect(await db.lead.findFirstOrThrow({ where: { phoneE164: "+12395550108" } })).toMatchObject({ fbLeadId: null, fbCampaign: null });
  });

  it("waits for the Facebook lead ID on a fresh lead before sending", async () => {
    Object.assign(process.env, env);
    const base = await seedBase();
    const r = await addLead(base);
    if (r.result !== "created") throw new Error("no lead");
    await db.lead.update({ where: { id: r.leadId }, data: { isDemo: false } });
    try {
      const res = await sendMetaStageEvent(r.leadId, "INTERESTED");
      expect(res && "rescheduleAt" in res).toBe(true);
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  });
});

describe("who ended the call", () => {
  it("reads Telnyx hangup fields first, then Crystal's hangup note in the transcript", async () => {
    const { whoEnded } = await import("@/lib/call-end");
    expect(whoEnded({ status: "COMPLETED", metrics: { hangup_source: "callee" } })).toBe("driver");
    expect(whoEnded({ status: "COMPLETED", transcript: [{ speaker: "agent", text: "Have a great day! [hangup]" }] })).toBe("agent");
    expect(whoEnded({ status: "COMPLETED", transcript: [{ speaker: "agent", text: "Hi, is this Jean?" }, { speaker: "driver", text: "yeah" }] })).toBe("driver");
    expect(whoEnded({ status: "COMPLETED" })).toBeNull();
    expect(whoEnded({ status: "VOICEMAIL" })).toBe("voicemail");
    expect(whoEnded({ status: "NO_ANSWER" })).toBeNull();
  });
});
