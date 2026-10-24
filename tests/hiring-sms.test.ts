import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { addLead, drain, resetDb, seedBase, setPersona } from "./helpers";
import { setHireStage, syncHiringFromSheet } from "@/lib/hiring";
import { smsSenderFor } from "@/lib/messaging";
import { attemptCallJob, callVariables, ingestVoiceEvent } from "@/lib/calls";
import { buildCallReport, recruiterTags, sendTelegram } from "@/lib/telegram";
import { toTurns } from "@/lib/telnyx-transcript";
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

describe("other teams' lead sheets", () => {
  const env = { APP_MODE: "live", GOOGLE_SHEETS_SPREADSHEET_ID: "SHEET", META_ACCESS_TOKEN: "TOKEN", META_DATASET_ID: "DS", GOOGLE_SHEETS_META_SPREADSHEETS: "https://docs.google.com/spreadsheets/d/TEAM1aaaaaaaaaaaaaaaaaaaa/edit?gid=1, TEAM3aaaaaaaaaaaaaaaaaaaa" };
  it("sends their good statuses to Facebook once per driver, without touching anything else", async () => {
    await seedBase();
    const sheets: Record<string, Record<string, string[][]>> = {
      SHEET: { Molly: [["(312) 555-0100", "Need to bring"]] },
      TEAM1aaaaaaaaaaaaaaaaaaaa: { Pool: [], Tyler: [["(312) 555-0100", "Need approval"], ["(312) 555-0200", "Need to talk"], ["(312) 555-0201", "Changed mind"], ["(312) 555-0202", "Not interested"]] },
      TEAM3aaaaaaaaaaaaaaaaaaaa: { Martin: [["312-555-0200", "Call back"], ["312-555-0203", "Hired"]] },
    };
    const asked: string[] = [];
    setAdapterOverride({ sheets: {
      status: () => ({ kind: "lead_source", provider: "test", state: "configured", isMock: true, detail: "" }),
      listTabs: async (id = "SHEET") => { asked.push(id); return Object.keys(sheets[id]).map((title, i) => ({ title, gid: String(i) })); },
      readSheet: async (t?: string, id = "SHEET") => ({ title: t!, headers: ["Phone", "Status"], rows: sheets[id][t!] ?? [], warnings: [] }),
    } as never });
    const sent: { event_name: string; user_data: { ph: string[] } }[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
      if (String(u).includes("/DS/events")) sent.push(JSON.parse(init!.body as string).data[0]);
      return new Response(JSON.stringify({ events_received: 1 }));
    });
    Object.assign(process.env, env);
    try {
      expect(await syncHiringFromSheet()).toMatchObject({ sent: 4 });
      expect(asked).toEqual(["SHEET", "TEAM1aaaaaaaaaaaaaaaaaaaa", "TEAM3aaaaaaaaaaaaaaaaaaaa"]);
      // 0100 Qualified once (our sheet first); 0200 Interested once; 0201 Interested; 0203 Hired.
      expect(sent.map((e) => e.event_name).sort()).toEqual(["Hired", "Interested", "Interested", "Qualified"]);
      // Other teams' drivers are not ours: no status rows, no calls.
      expect(await db.sheetLeadStatus.count()).toBe(1);
      expect(await syncHiringFromSheet()).toMatchObject({ sent: 0 });
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

describe("Live transfer to the recruiter of the driver's sheet tab", () => {
  it("connects Dennis's tab drivers to Dennis and everyone else to the main line", async () => {
    const base = await seedBase();
    await db.systemSetting.update({ where: { id: "global" }, data: { recruiterTransfer: "Dennis = (815) 846-1661\nBroken = 12" } });
    await db.user.updateMany({ data: { availableForTransfer: false } });
    await db.user.update({ where: { id: (await db.user.findFirstOrThrow()).id }, data: { availableForTransfer: true, transferPhoneE164: "+13149310525" } });
    const vars = async (phone: string, tab?: string) => {
      const r = await addLead(base, { phone });
      if (r.result !== "created") throw new Error("no lead");
      const l = await db.lead.findUniqueOrThrow({ where: { id: r.leadId }, include: { permissions: true } });
      if (tab) await db.sheetLeadStatus.create({ data: { phoneE164: l.phoneE164, tab, status: "No answer" } });
      return callVariables(l, "att", "ov");
    };
    expect(await vars("(214) 555-0181", "Dennis")).toMatchObject({ transfer_number: "+18158461661", recruiter_phone: "+18158461661", transfer_target: "Dennis" });
    expect(await vars("(214) 555-0182", "Molly")).toMatchObject({ transfer_number: "+13149310525", transfer_target: "office" });
    expect(await vars("(214) 555-0183")).toMatchObject({ transfer_number: "+13149310525", transfer_target: "office" });
  });

  it("a driver imported from Dennis's own tab goes to Dennis, and the card says who took the call", async () => {
    const base = await seedBase();
    await db.systemSetting.update({ where: { id: "global" }, data: { recruiterTransfer: "Dennis = +18158461661" } });
    setAdapterOverride({ sheets: { status: () => ({}), readSheet: async () => ({ title: "", headers: [], rows: [], warnings: [] }), listTabs: async () => [{ title: "📥 Pool", gid: "1" }, { title: "Dennis", gid: "1759604612" }] } as never });
    process.env.GOOGLE_SHEETS_EXTRA_TABS = "1759604612=@tonyhope7";
    try {
      const l = await db.lead.create({ data: { orgId: base.org.id, campaignId: base.campaign.id, firstName: "Maksim", phoneE164: "+15125550199", isDemo: false } });
      await db.leadSourceRecord.create({ data: { leadId: l.id, sourceSystem: "GOOGLE_SHEETS:1759604612", sourceRecordId: "phone:+15125550199", raw: {} } });
      const full = await db.lead.findUniqueOrThrow({ where: { id: l.id }, include: { permissions: true } });
      expect(await callVariables(full, "att", "ov")).toMatchObject({ transfer_number: "+18158461661", transfer_target: "Dennis" });
      const turns = toTurns([
        { role: "assistant", text: "Perfect, I'm connecting you with my manager right now.", created_at: "2026-10-24T21:52:20Z", tool_calls: [{ function: { name: "transfer", arguments: JSON.stringify({ target: "Dennis" }) } }] },
        { role: "user", text: "Okay.", created_at: "2026-10-24T21:52:10Z" },
      ]);
      expect(turns.map((t) => t.text)).toEqual(["Okay.", "Perfect, I'm connecting you with my manager right now. [transfer: Dennis]"]);
      const started = new Date(Date.now() - 300_000);
      const a = await db.callAttempt.create({ data: { leadId: l.id, provider: "telnyx", idempotencyKey: "tr-1", status: "COMPLETED", outcome: "HUMAN_REQUESTED", startedAt: started, endedAt: new Date(started.getTime() + 278_000), transcript: turns } });
      expect(await buildCallReport(a.id)).toContain("🔀 Crystal transferred the driver to Dennis (278 sec call)");
    } finally {
      delete process.env.GOOGLE_SHEETS_EXTRA_TABS;
    }
  });
});

describe("one Telegram thread per driver", () => {
  it("sends later messages about a lead as replies to the first one", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t"; process.env.TELEGRAM_CHAT_ID = "-100";
    const base = await seedBase();
    const r = await addLead(base);
    if (r.result !== "created") throw new Error("no lead");
    const forms: FormData[] = [];
    let n = 76;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => {
      forms.push(init!.body as FormData);
      return new Response(JSON.stringify({ ok: true, result: { message_id: ++n } }));
    });
    try {
      await sendTelegram("first", r.leadId);
      await sendTelegram("second", r.leadId);
      await sendTelegram("not about a lead");
      expect(forms[0].get("reply_parameters")).toBeNull();
      expect(JSON.parse(String(forms[1].get("reply_parameters")))).toEqual({ message_id: 77, allow_sending_without_reply: true });
      expect(forms[2].get("reply_parameters")).toBeNull();
      expect((await db.lead.findUniqueOrThrow({ where: { id: r.leadId } })).telegramThread).toBe("-100:77");
    } finally {
      spy.mockRestore();
    }
  });

  it("follows the group to its new id when Telegram upgrades it to a supergroup", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t"; process.env.TELEGRAM_CHAT_ID = "-555";
    const base = await seedBase();
    const r = await addLead(base);
    if (r.result !== "created") throw new Error("no lead");
    await db.lead.update({ where: { id: r.leadId }, data: { telegramThread: "-555:10" } });
    const chats: string[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => {
      const chat = String((init!.body as FormData).get("chat_id"));
      chats.push(chat);
      if (chat === "-555") return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: -1004397263565 } }), { status: 400 });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }));
    });
    try {
      await sendTelegram("card", r.leadId);
      await sendTelegram("next card", r.leadId);
      expect(chats).toEqual(["-555", "-1004397263565", "-1004397263565"]);
      expect((await db.lead.findUniqueOrThrow({ where: { id: r.leadId } })).telegramThread).toBe("-1004397263565:5");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("No AI repeat calls once the driver talked or a recruiter set a status", () => {
  it("hands a driver who gave their details to the recruiter instead of calling again", async () => {
    const base = await seedBase();
    await db.campaign.update({ where: { id: base.campaign.id }, data: { isDemo: false } });
    const l = await db.lead.create({ data: { orgId: base.org.id, campaignId: base.campaign.id, firstName: "Irokalu", lastName: "O", phoneE164: "+17315069681", attemptCount: 1, pipelineStatus: "CONTACTING" } });
    const t0 = new Date(Date.now() - 400_000);
    const a = await db.callAttempt.create({ data: { leadId: l.id, provider: "telnyx", providerCallId: "pc-iro", idempotencyKey: "iro-1", status: "IN_PROGRESS", statusRank: 3, startedAt: t0 } });
    for (const [key, v] of [["experience_years", "almost three years"], ["home_time", "three weeks out"], ["english_level", "Fair"]]) {
      await db.screeningField.create({ data: { leadId: l.id, key, reportedValue: v, callAttemptId: a.id } });
    }
    await ingestVoiceEvent({ provider: "telnyx", eventId: "iro-end", type: "call_ended", providerCallId: "pc-iro", status: "COMPLETED", outcome: "INCOMPLETE" });
    expect(await db.job.count({ where: { type: "lead.attempt-call", status: "PENDING", payload: { path: ["leadId"], equals: l.id } } })).toBe(0);
    const after = await db.lead.findUniqueOrThrow({ where: { id: l.id } });
    expect(after.queueReason).toBe("Talked with Crystal: recruiter continues");
    expect(await db.task.count({ where: { leadId: l.id, type: "CALLBACK", status: "OPEN" } })).toBe(1);

    // A later voicemail on a driver who talked before gets the short note, not their old card.
    const vm = await db.callAttempt.create({ data: { leadId: l.id, provider: "telnyx", idempotencyKey: "iro-2", status: "COMPLETED", outcome: "INCOMPLETE", startedAt: new Date(Date.now() - 17_000), endedAt: new Date(),
      metrics: { callNotes: { result: "unclear", unanswered: "experience, location" } }, summary: "Call went to voicemail." } });
    const card = (await buildCallReport(vm.id))!;
    expect(card).toContain("no answers collected");
    expect(card).not.toContain("❓");
    expect(card).not.toContain("📝");
    expect(card).toContain("⏹ No more AI calls: Talked with Crystal: recruiter continues");

    // A retry queued before this rule existed is not placed either.
    await db.lead.update({ where: { id: l.id }, data: { queueReason: "Retry after incomplete" } });
    await db.task.deleteMany({ where: { leadId: l.id } });
    const calls = await db.callAttempt.count({ where: { leadId: l.id } });
    await attemptCallJob({ payload: { leadId: l.id } } as never);
    expect(await db.callAttempt.count({ where: { leadId: l.id } })).toBe(calls);
    expect((await db.lead.findUniqueOrThrow({ where: { id: l.id } })).queueReason).toBe("Talked with Crystal: recruiter continues");
  });

  it("any recruiter status stops the queued AI calls", async () => {
    const base = await seedBase();
    const r = await addLead(base);
    if (r.result !== "created") throw new Error("no lead");
    await db.job.create({ data: { type: "lead.attempt-call", payload: { leadId: r.leadId }, runAt: new Date(Date.now() + 3600_000) } });
    await setHireStage(r.leadId, "PROCESSING", null, { id: base.admin.id, name: "Ben" });
    expect(await db.job.count({ where: { type: "lead.attempt-call", status: "PENDING", payload: { path: ["leadId"], equals: r.leadId } } })).toBe(0);
    const l = await db.lead.findUniqueOrThrow({ where: { id: r.leadId } });
    expect(l.queueReason).toBe("Recruiter is working with the driver (status: Processing by recruiter)");
    // A call already due is not placed either.
    await attemptCallJob({ payload: { leadId: r.leadId } } as never);
    expect(await db.callAttempt.count({ where: { leadId: r.leadId } })).toBe(0);
    await setHireStage(r.leadId, "SAFETY_DECLINED", null, { id: base.admin.id, name: "Ben" });
    expect((await db.lead.findUniqueOrThrow({ where: { id: r.leadId } })).hireStage).toBe("SAFETY_DECLINED");
  });
});
