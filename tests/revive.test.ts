import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { classifyRow, reviveScan, reviveStillOpen, reviveSummary, reviveResults } from "@/lib/revive";
import { callVariables } from "@/lib/calls";
import { resetDb, seedBase } from "./helpers";

const DAY = 86400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);

beforeEach(async () => { await resetDb(); });

describe("old leads (revive)", () => {
  it("sorts sheet rows by why they are stuck", () => {
    expect(classifyRow({ status: "No answer", appliedAt: ago(30), statusAt: ago(30), experience: "2+ years" })).toEqual({ segment: "never" });
    expect(classifyRow({ status: "Need to talk", appliedAt: ago(60), statusAt: ago(20), experience: null })).toEqual({ segment: "quiet" });
    expect(classifyRow({ status: "callback", appliedAt: ago(60), statusAt: ago(5), experience: null })).toEqual({ skip: "Too recent", later: true });
    expect(classifyRow({ status: "Not interested", appliedAt: ago(90), statusAt: ago(50), experience: null })).toEqual({ segment: "no" });
    expect(classifyRow({ status: "Not interested", appliedAt: ago(90), statusAt: ago(20), experience: null })).toMatchObject({ later: true });
    expect(classifyRow({ status: "SAP", appliedAt: ago(90), statusAt: ago(90), experience: null })).toEqual({ skip: "SAP" });
    expect(classifyRow({ status: "Application", appliedAt: ago(90), statusAt: ago(90), experience: null })).toEqual({ skip: "In process with a recruiter" });
    expect(classifyRow({ status: "No answer", appliedAt: ago(30), statusAt: ago(30), experience: "Less than 1 year" })).toEqual({ skip: "Under 1 year experience" });
    expect(classifyRow({ status: "No answer", appliedAt: ago(400), statusAt: ago(400), experience: null })).toEqual({ skip: "Applied over a year ago" });
  });

  it("picks today's old leads, newest stuck first, and calls them only while the sheet status holds", async () => {
    const base = await seedBase();
    await db.campaign.update({ where: { id: base.campaign.id }, data: { isDemo: false, reviveEnabled: true, revivePerDay: 2 } });
    const org = base.org.id;
    const row = (phone: string, status: string, appliedDays: number, statusDays = appliedDays, name = "Jamal Brown") =>
      db.sheetRow.create({ data: { orgId: org, phoneE164: phone, tab: "Daniel", status, appliedAt: ago(appliedDays), statusAt: ago(statusDays), name } });
    await row("+13125550101", "No answer", 40);
    await row("+13125550102", "Need to talk", 80, 30, "Ray Cole");
    await row("+13125550103", "No answer", 20);
    await row("+13125550104", "Hired", 100);
    await row("+13125550105", "SAP", 50);
    // Opted out earlier.
    await db.suppression.create({ data: { phoneE164: "+13125550103", reason: "STOP", source: "sms" } });

    const s = await reviveSummary(org);
    expect(s.segments.quiet.ready).toBe(1);
    expect(s.segments.never.ready).toBe(1);
    expect(s.skipped.map((x) => x.reason).sort()).toEqual(["Hired / our driver", "Opted out", "SAP"]);

    expect(await reviveScan()).toEqual({ queued: 2 });
    const quiet = await db.lead.findFirstOrThrow({ where: { phoneE164: "+13125550102" }, include: { permissions: true } });
    expect(quiet).toMatchObject({ firstName: "Ray", reviveFrom: "Need to talk", reviveTab: "Daniel", attemptCount: 1 });
    expect(quiet.reengagedAt).not.toBeNull();
    expect(await db.job.count({ where: { type: "lead.attempt-call", status: "PENDING", payload: { path: ["leadId"], equals: quiet.id } } })).toBe(1);
    // Crystal opens with "you talked with our team a while back".
    const vars = await callVariables(quiet, "a1", "v1");
    expect(vars).toMatchObject({ follow_up: "yes", talked_before: "yes" });

    // Already picked today: nothing more; never picked twice.
    expect(await reviveScan()).toEqual({ queued: 0 });
    await db.campaign.update({ where: { id: base.campaign.id }, data: { revivePerDay: 10 } });
    expect(await reviveScan()).toEqual({ queued: 0 });

    // The recruiter's "Need to talk" still holds even though it means a recruiter has the driver.
    await db.lead.update({ where: { id: quiet.id }, data: { hireStage: "PROCESSING" } });
    expect(await reviveStillOpen(quiet)).toBe(true);
    // The recruiter moves the driver on in the sheet: Crystal stops.
    await db.sheetRow.update({ where: { orgId_phoneE164: { orgId: org, phoneE164: "+13125550102" } }, data: { status: "Need to bring" } });
    expect(await reviveStillOpen(quiet)).toBe(false);

    const r = await reviveResults(org);
    expect(r.all.picked).toBe(2);
    expect(r.bySegment.quiet.picked).toBe(1);
  });
});
