import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { addLead, drain, resetDb, seedBase, setPersona } from "./helpers";
import { setHireStage, syncHiringFromSheet } from "@/lib/hiring";
import { smsSenderFor } from "@/lib/messaging";
import { attemptCallJob } from "@/lib/calls";
import { recruiterTags } from "@/lib/telegram";
import { mockSmsOutbox } from "@/adapters/mock";
import { setAdapterOverride } from "@/adapters/registry";
import type { SmsProvider, SmsSender } from "@/adapters/types";

beforeEach(async () => { await resetDb(); });
afterEach(() => {
  delete process.env.RINGCENTRAL_TAB_SENDERS; delete process.env.RINGCENTRAL_JWT_1759604612; delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_ID;
  setAdapterOverride(null);
});

describe("hiring result", () => {
  it("records the stage, the hire date and tells Telegram once", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t"; process.env.TELEGRAM_CHAT_ID = "-1";
    const base = await seedBase();
    const r = await addLead(base);
    if (r.result !== "created") throw new Error("no lead");
    await db.lead.update({ where: { id: r.leadId }, data: { isDemo: false } });
    const actor = { id: base.admin.id, name: "Denis" };
    await setHireStage(r.leadId, "ORIENTATION", "Mon 8 AM", actor);
    let l = await db.lead.findUniqueOrThrow({ where: { id: r.leadId } });
    expect(l).toMatchObject({ hireStage: "ORIENTATION", hireNote: "Mon 8 AM", hiredAt: null });
    await setHireStage(r.leadId, "HIRED", null, actor);
    await setHireStage(r.leadId, "HIRED", null, actor);
    l = await db.lead.findUniqueOrThrow({ where: { id: r.leadId } });
    expect(l.hireStage).toBe("HIRED");
    expect(l.hiredAt).toBeInstanceOf(Date);
    expect(await db.job.count({ where: { type: "notify.telegram-hired" } })).toBe(1);
    expect(await db.activityEvent.count({ where: { leadId: r.leadId, type: "HIRE_STAGE" } })).toBe(2);
    await setHireStage(r.leadId, "NOT_HIRED", "failed drug test", actor);
    l = await db.lead.findUniqueOrThrow({ where: { id: r.leadId } });
    expect(l.hiredAt).toBeNull();
  });
});

describe("texts from the recruiter's own number", () => {
  const denisTab = () => { process.env.RINGCENTRAL_TAB_SENDERS = "1759604612=+18155550100"; process.env.RINGCENTRAL_JWT_1759604612 = "denis-jwt"; };

  it("uses the tab recruiter's number for that tab's leads only", async () => {
    denisTab();
    const base = await seedBase();
    const denis = await addLead(base, { sourceSystem: "GOOGLE_SHEETS:1759604612" });
    const pool = await addLead(base, { sourceSystem: "GOOGLE_SHEETS" });
    if (denis.result !== "created" || pool.result !== "created") throw new Error("no lead");
    expect(await smsSenderFor(denis.leadId)).toMatchObject({ from: "+18155550100", jwt: "denis-jwt" });
    expect(await smsSenderFor(pool.leadId)).toBeNull();
    // Without the recruiter's JWT the tab falls back to the company number.
    delete process.env.RINGCENTRAL_JWT_1759604612;
    expect(await smsSenderFor(denis.leadId)).toBeNull();
  });

  it("sends the missed-call text from the recruiter's number", async () => {
    denisTab();
    const base = await seedBase();
    await db.systemSetting.update({ where: { id: "global" }, data: { requireSmsPermission: false } });
    const r = await addLead(base, { sourceSystem: "GOOGLE_SHEETS:1759604612" });
    if (r.result !== "created") throw new Error("no lead");
    const before = mockSmsOutbox.length;
    await setPersona(r.leadId, "no_answer");
    await drain();
    const sent = mockSmsOutbox.slice(before).filter((m) => /tried to call you/.test(m.body));
    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe("+18155550100");
  });

  it("on a live line, sends no missed-call text from the company number", async () => {
    const calls: (SmsSender | null | undefined)[] = [];
    const live: SmsProvider = { key: "test-live", isMock: false, status: () => ({ kind: "sms", provider: "t", isMock: false, state: "configured", detail: "" }), send: async (_t, _b, _i, s) => { calls.push(s); return { providerMessageId: `t_${calls.length}` }; } };
    setAdapterOverride({ sms: live });
    const base = await seedBase();
    await db.systemSetting.update({ where: { id: "global" }, data: { requireSmsPermission: false } });
    const r = await addLead(base, { sourceSystem: "GOOGLE_SHEETS" });
    if (r.result !== "created") throw new Error("no lead");
    await setPersona(r.leadId, "no_answer");
    await drain();
    expect(await db.message.count({ where: { leadId: r.leadId, purpose: "MISSED_CALL" } })).toBe(0);
  });
});

describe("missed-call texts: greeting + offer", () => {
  it("fills the driver's name and position, then sends the offer as a second text", async () => {
    const base = await seedBase();
    await db.systemSetting.update({ where: { id: "global" }, data: {
      requireSmsPermission: false, requireCallPermission: false,
      missedCallSmsText: "Good part of the day {name}\nIt is {persona}\nYou have applied for {position} position",
      missedCallSmsOffer: "Requirements:\n- Minimum 2 year of CDL Class A",
    } });
    const csv = Buffer.from("Name,Phone,Source\nDerrick Johnson,(214) 555-0177,TEAM\n");
    const { createImportPreview, commitBatch } = await import("@/lib/import");
    const b = await createImportPreview({ fileName: "leads.csv", data: csv, campaignId: base.campaign.id, userId: base.admin.id, orgId: base.org.id, isDemo: true });
    await commitBatch(b.id, base.admin);
    const lead = await db.lead.findFirstOrThrow({ where: { phoneE164: "+12145550177" } });
    expect((await db.leadSourceRecord.findFirstOrThrow({ where: { leadId: lead.id } })).raw).toMatchObject({ position: "team" });
    await setPersona(lead.id, "no_answer");
    await drain();
    const msgs = await db.message.findMany({ where: { leadId: lead.id, purpose: "MISSED_CALL" }, orderBy: { createdAt: "asc" } });
    expect(msgs.map((m) => m.body)).toEqual([
      "Good part of the day Derrick Johnson\nIt is Crystal\nYou have applied for team driver position",
      "Requirements:\n- Minimum 2 year of CDL Class A",
    ]);
  });
});

describe("hiring and good outcomes from the recruiters' lead sheet", () => {
  const env = { APP_MODE: "live", GOOGLE_SHEETS_SPREADSHEET_ID: "SHEET", META_ACCESS_TOKEN: "TOKEN", META_DATASET_ID: "DS" };
  it("copies Hired / Application onto our leads and sends each good status to Facebook once", async () => {
    const base = await seedBase();
    const r = await addLead(base, { phone: "(214) 555-0177" });
    if (r.result !== "created") throw new Error("no lead");
    await db.lead.update({ where: { id: r.leadId }, data: { isDemo: false } });
    const tabs: Record<string, string[][]> = {
      Pool: [],
      Molly: [["(214) 555-0177", "Hired"], ["(312) 555-0100", "Need to bring"], ["(312) 555-0101", "No answer"], ["(312) 555-0102", "Call back"]],
      Ben: [["312-555-0103", "Application"], ["312-555-0100", "Need to bring"]],
      Notes: [],
    };
    setAdapterOverride({ sheets: {
      status: () => ({ kind: "lead_source", provider: "test", state: "configured", isMock: true, detail: "" }),
      listTabs: async () => Object.keys(tabs).map((title, i) => ({ title, gid: String(i) })),
      readSheet: async (t?: string) => ({ title: t!, headers: t === "Notes" ? ["Note"] : ["Phone", "Status"], rows: tabs[t!] ?? [], warnings: [] }),
    } as never });
    const sent: { event_name: string }[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
      if (String(u).includes("/DS/events")) sent.push(JSON.parse(init!.body as string).data[0]);
      return new Response(JSON.stringify({ events_received: 1 }));
    });
    Object.assign(process.env, env);
    try {
      expect(await syncHiringFromSheet()).toEqual({ tabs: 3, updated: 1, sent: 3, recalled: 0 });
      const l = await db.lead.findUniqueOrThrow({ where: { id: r.leadId } });
      expect(l.hireStage).toBe("HIRED");
      const ev = await db.activityEvent.findFirstOrThrow({ where: { leadId: r.leadId, type: "HIRE_STAGE" } });
      expect(ev.actorType).toBe("SYSTEM");
      // Our lead's "Hired" goes through the lead's own Meta job; sheet-only drivers go directly.
      expect(sent.map((e) => e.event_name).sort()).toEqual(["Application", "Interested", "Qualified"]);
      expect(await db.job.count({ where: { type: "meta.send-event" } })).toBe(1);
      expect(await syncHiringFromSheet()).toEqual({ tabs: 3, updated: 0, sent: 0, recalled: 0 });
      // The sheet changes later: a "No answer" driver was reached by a recruiter.
      tabs.Molly[2][1] = "Call back";
      expect(await syncHiringFromSheet()).toMatchObject({ sent: 1 });
      expect(sent.at(-1)!.event_name).toBe("Interested");
      expect(await db.sheetLeadStatus.findUniqueOrThrow({ where: { phoneE164: "+13125550101" } })).toMatchObject({ tab: "Molly", status: "Call back" });
      expect(await db.sheetLeadStatus.findUniqueOrThrow({ where: { phoneE164: "+13125550100" } })).toMatchObject({ status: "Need to bring" });
    } finally {
      spy.mockRestore();
      for (const k of Object.keys(env)) delete process.env[k];
      process.env.APP_MODE = "demo";
    }
  });
});

describe("follow-up call a month later", () => {
  it("is not placed when a recruiter has talked to the driver since", async () => {
    const base = await seedBase();
    const r = await addLead(base, { phone: "(214) 555-0188" });
    if (r.result !== "created") throw new Error("no lead");
    await db.job.deleteMany({});
    await db.lead.update({ where: { id: r.leadId }, data: { isDemo: false, reengagedAt: new Date(), pipelineStatus: "QUEUED" } });
    await db.sheetLeadStatus.create({ data: { phoneE164: "+12145550188", tab: "Molly", status: "Not qualified" } });
    await attemptCallJob({ payload: { leadId: r.leadId } } as never);
    expect(await db.callAttempt.count({ where: { leadId: r.leadId } })).toBe(0);
    const l = await db.lead.findUniqueOrThrow({ where: { id: r.leadId } });
    expect(l.queueReason).toBe("Recruiter already talked to the driver (sheet Molly tab: Not qualified)");
  });

  it("retries stop too once the recruiter's status changes; the first call does not wait for it", async () => {
    const base = await seedBase();
    const r = await addLead(base, { phone: "(214) 555-0189" });
    if (r.result !== "created") throw new Error("no lead");
    await db.job.deleteMany({});
    await db.lead.update({ where: { id: r.leadId }, data: { isDemo: false, attemptCount: 2, pipelineStatus: "QUEUED" } });
    await db.sheetLeadStatus.create({ data: { phoneE164: "+12145550189", tab: "Dennis", status: "Need to talk" } });
    await attemptCallJob({ payload: { leadId: r.leadId } } as never);
    expect(await db.callAttempt.count({ where: { leadId: r.leadId } })).toBe(0);
    expect((await db.lead.findUniqueOrThrow({ where: { id: r.leadId } })).queueReason).toMatch(/Dennis tab: Need to talk/);
  });
});

describe("re-calling sheet leads the recruiters could not reach", () => {
  it("calls 'No answer' drivers who applied 7-60 days ago, newest first, a few per day", async () => {
    const base = await seedBase();
    await db.campaign.update({ where: { id: base.campaign.id }, data: { recallMinDays: 7, recallMaxDays: 60, recallPerDay: 2, maxAttempts: 5, isDemo: false } });
    await db.sourceConnection.create({ data: { id: "google-sheets", orgId: base.campaign.orgId, campaignId: base.campaign.id, mapping: { phone: "Phone", fullName: "Name" } } });
    const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();
    const known = await addLead(base, { phone: "(312) 555-0109" });
    if (known.result !== "created") throw new Error("no lead");
    const rows = [
      [day(3), "Too New", "(312) 555-0101", "No answer"],
      [day(10), "Ten Days", "(312) 555-0102", "No answer"],
      [day(20), "Twenty Days", "(312) 555-0103", "No Answer"],
      [day(30), "Thirty Days", "(312) 555-0104", "No answer"],
      [day(90), "Too Old", "(312) 555-0105", "No answer"],
      [day(15), "Talked", "(312) 555-0106", "Not interested"],
      [day(12), "Already Ours", "(312) 555-0109", "No answer"],
    ];
    setAdapterOverride({ sheets: {
      idColumn: "Phone",
      status: () => ({ kind: "lead_source", provider: "test", state: "configured", isMock: true, detail: "" }),
      listTabs: async () => [{ title: "Ben", gid: "77" }],
      readSheet: async () => ({ title: "Ben", headers: ["Applied", "Name", "Phone", "Status"], rows, warnings: [] }),
    } as never });
    Object.assign(process.env, { APP_MODE: "live", GOOGLE_SHEETS_SPREADSHEET_ID: "SHEET" });
    try {
      expect(await syncHiringFromSheet()).toMatchObject({ recalled: 2 });
      expect(await syncHiringFromSheet()).toMatchObject({ recalled: 0 }); // 2 per day
      const leads = await db.lead.findMany({ where: { sourceRecords: { some: { sourceRecordId: { startsWith: "recall:" } } } }, include: { permissions: true } });
      expect(leads.map((l) => l.firstName).sort()).toEqual(["Ten", "Twenty"]);
      for (const l of leads) {
        expect(l).toMatchObject({ attemptCount: 3, isDemo: false });
        expect(l.reengagedAt).toBeInstanceOf(Date);
        expect(l.permissions[0].scope).toBe("AI_CALL");
        expect(await db.job.count({ where: { type: "lead.attempt-call", payload: { path: ["leadId"], equals: l.id } } })).toBe(1);
      }
      // Next day the next newest; the recruiter changing the status first stops the call.
      rows[3][3] = "Call back";
      expect(await syncHiringFromSheet(new Date(Date.now() + 86400_000))).toMatchObject({ recalled: 0 });
    } finally {
      delete process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
      process.env.APP_MODE = "demo";
    }
  });
});

describe("Telegram tags the recruiter of the lead's sheet tab", () => {
  it("tags a recruiter in the group, names one who left", async () => {
    const base = await seedBase();
    await db.systemSetting.update({ where: { id: "global" }, data: { recruiterTelegram: "Molly = @molly_tbt\nBen =\nPool = @nobody" } });
    const mk = async (phone: string, tab: string, recall: boolean) => {
      const r = await addLead(base, { phone });
      if (r.result !== "created") throw new Error("no lead");
      const p = (await db.lead.findUniqueOrThrow({ where: { id: r.leadId } })).phoneE164;
      if (recall) await db.leadSourceRecord.create({ data: { leadId: r.leadId, sourceSystem: "GOOGLE_SHEETS:5", sourceRecordId: `recall:${p}`, raw: { tab } } });
      else await db.sheetLeadStatus.create({ data: { phoneE164: p, tab, status: "Call back" } });
      return r.leadId;
    };
    expect(await recruiterTags(await mk("(214) 555-0191", "Molly", true))).toEqual(["@molly_tbt"]);
    expect(await recruiterTags(await mk("(214) 555-0192", "Ben", true))).toEqual(["👤 Before processed by Ben"]);
    expect(await recruiterTags(await mk("(214) 555-0193", "Luke", false))).toEqual(["👤 Before processed by Luke"]);
    expect(await recruiterTags(await mk("(214) 555-0194", "📥 Pool", false))).toEqual([]);
  });
});
