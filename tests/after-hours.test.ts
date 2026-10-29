import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { addLead, resetDb, seedBase } from "./helpers";
import { normalizeOfficeHours, officeOpen, nextOpening, localClock } from "@/lib/office-hours";
import { applyAgentAction, callVariables, requestTransfer, OFFICE_CLOSED } from "@/lib/calls";
import { loadOnProcess, processRowsOf, saveProcessRows } from "@/lib/on-process";
import { normalizePhone } from "@/lib/phone";
import { config } from "@/lib/config";

beforeEach(async () => { await resetDb(); });

// 2026-10-29 23:00 UTC = Oct 30, 04:00 in Tashkent (UTC+5).
const NIGHT = new Date("2026-10-29T23:00:00Z");
const EVENING = new Date("2026-10-29T13:00:00Z"); // 18:00 Tashkent

async function liveLeadWithCall() {
  const base = await seedBase();
  const r = await addLead(base, { phone: "(214) 555-0160" });
  if (r.result !== "created") throw new Error("no lead");
  await db.lead.update({ where: { id: r.leadId }, data: { timezone: "America/Chicago" } });
  const call = await db.callAttempt.create({ data: { leadId: r.leadId, provider: "telnyx", idempotencyKey: `ah-${r.leadId}`, status: "IN_PROGRESS", providerCallId: "v3:abc", startedAt: new Date() } });
  return { base, leadId: r.leadId, attemptId: call.id };
}

describe("office hours", () => {
  it("reads shift hours that run past midnight, in Tashkent time", () => {
    expect(normalizeOfficeHours("5pm-3am")).toBe("17:00-03:00");
    expect(normalizeOfficeHours(" 17:00 - 5:00 ")).toBe("17:00-05:00");
    expect(normalizeOfficeHours("")).toBeNull();
    expect(normalizeOfficeHours("late")).toBeUndefined();
    expect(officeOpen("17:00-03:00", EVENING)).toBe(true);
    expect(officeOpen("17:00-03:00", NIGHT)).toBe(false); // 04:00: the company's team went home at 3
    expect(officeOpen("17:00-05:00", NIGHT)).toBe(true); // First team works until 5
    expect(officeOpen(null, NIGHT)).toBe(true);
    // Opens again at 17:00 Tashkent = 7 AM Central (CDT).
    expect(localClock(nextOpening("17:00-03:00", NIGHT), "America/Chicago")).toBe("7 AM");
  });

  it("never transfers after hours: Crystal books a recruiter call and the recruiter gets a reminder", async () => {
    const { base, leadId, attemptId } = await liveLeadWithCall();
    await db.organization.update({ where: { id: base.org.id }, data: { officeHours: "17:00-03:00" } });
    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, include: { permissions: true } });
    const vars = await callVariables(lead, attemptId, base.offerVersion.id, NIGHT);
    expect(vars).toMatchObject({ office_open: "no", office_opens: "7 AM" });
    expect(vars.now_local).toContain("America/Chicago");

    // Office hours are checked against the real clock: an hour-long shift starting 2 hours from now.
    const h = (Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tashkent", hour: "numeric", hourCycle: "h23" }).format(new Date())) + 2) % 24;
    await db.organization.update({ where: { id: base.org.id }, data: { officeHours: `${h}:00-${(h + 1) % 24}:00` } });
    expect(await requestTransfer(attemptId, "HUMAN_REQUESTED")).toEqual({ ok: false, transfer: "failed", detail: OFFICE_CLOSED });
    expect(await db.handoff.count({ where: { leadId } })).toBe(0); // no "transfer failed" task for a closed office

    const at = new Date(Date.now() + 10 * 3600_000);
    await db.job.create({ data: { type: "lead.attempt-call", payload: { leadId }, runAt: new Date(Date.now() + 3600_000) } });
    expect(await applyAgentAction(attemptId, { type: "schedule_callback", at: at.toISOString(), raw: "tomorrow at 9", by: "recruiter" })).toEqual({ ok: true });
    const l = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(l.recruiterCallAt?.getTime()).toBe(at.getTime());
    expect(l.nextContactAt).toBeNull(); // Crystal does not call; the recruiter does
    expect(l.queueReason).toMatch(/^Recruiter to call .* Tashkent\)$/);
    expect(await db.job.count({ where: { type: "lead.attempt-call", status: "PENDING" } })).toBe(0);
    const reminder = await db.job.findFirstOrThrow({ where: { type: "notify.recruiter-call-reminder" } });
    expect(reminder.runAt.getTime()).toBe(at.getTime() - 5 * 60_000);
  });

  it("a driver under 2 years who takes the team offer gets the Need teammate status", async () => {
    const { leadId, attemptId } = await liveLeadWithCall();
    await applyAgentAction(attemptId, { type: "record_slot", key: "offer_interest", value: "Interested - need teammate", raw: "yeah team is fine", status: "CAPTURED" });
    const l = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(l.recruiterStatus).toBe("Need teammate");
    expect(l.hireStage).toBe("PROCESSING");
  });

  it("introduces Crystal as the recruiters' assistant, never Molly's", () => {
    const before = process.env.AGENT_ROLE;
    process.env.AGENT_ROLE = "Molly's assistant";
    expect(config.agentPersona.role).toBe("the recruiters' assistant");
    if (before === undefined) delete process.env.AGENT_ROLE; else process.env.AGENT_ROLE = before;
  });
});

describe("on process", () => {
  it("lists each recruiter's Need to bring / Need approval / Application drivers from the sheet; managers see everyone's", async () => {
    const base = await seedBase();
    const r = await addLead(base, { phone: "(214) 555-0171" });
    if (r.result !== "created") throw new Error("no lead");
    await db.lead.update({ where: { id: r.leadId }, data: { isDemo: false } });
    const headers = ["Name", "Phone", "Status", "Experience"];
    const molly = processRowsOf("Molly", headers, [
      ["Ann Lee", "(214) 555-0171", "need to bring", "3 years"],
      ["Bob Ray", "(214) 555-0172", "No answer", ""],
      ["Cy Fox", "(214) 555-0173", "Application", "5 years"],
    ], normalizePhone);
    const alex = processRowsOf("Alex", headers, [["Dee Kim", "(214) 555-0174", "Need approval", "2 years"]], normalizePhone);
    expect(processRowsOf("Pool", headers, [["X", "(214) 555-0175", "Application", ""]], normalizePhone)).toEqual([]);
    await saveProcessRows(base.org.id, [...molly, ...alex]);

    const mine = await loadOnProcess(base.molly);
    expect(mine.map((d) => [d.name, d.status, d.leadId !== null])).toEqual(expect.arrayContaining([["Ann Lee", "Need to bring", true], ["Cy Fox", "Application", false]]));
    expect(mine).toHaveLength(2);
    const all = await loadOnProcess(base.admin);
    expect(all.map((d) => d.recruiter).sort()).toEqual(["Alex", "Molly", "Molly"]);

    // A driver who left the list in the sheet leaves the page.
    await saveProcessRows(base.org.id, alex);
    expect(await loadOnProcess(base.molly)).toHaveLength(0);
  });
});
