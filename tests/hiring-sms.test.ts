import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { addLead, drain, resetDb, seedBase, setPersona } from "./helpers";
import { setHireStage } from "@/lib/hiring";
import { smsSenderFor } from "@/lib/messaging";
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
