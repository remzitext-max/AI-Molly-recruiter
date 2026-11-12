import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { addReferral, referralsOf, referrerOf } from "@/lib/referral";
import { runAgentTool, findToolAttempt } from "@/lib/agent-tools";
import { callVariables } from "@/lib/calls";
import { buildCallReport } from "@/lib/telegram";
import { resetDb, seedBase } from "./helpers";

beforeEach(async () => { await resetDb(); });

describe("referrals", () => {
  it("saves a friend as a lead for a recruiter, never for Crystal to call", async () => {
    const base = await seedBase();
    await db.campaign.update({ where: { id: base.campaign.id }, data: { isDemo: false } });
    const lead = await db.lead.create({ data: { orgId: base.org.id, campaignId: base.campaign.id, isDemo: false, firstName: "Ray", lastName: "Cole", phoneE164: "+13125550102", timezone: "America/Chicago" } });
    const attempt = await db.callAttempt.create({ data: { leadId: lead.id, provider: "telnyx", idempotencyKey: "ref-a1", status: "COMPLETED", startedAt: new Date(Date.now() - 120_000), endedAt: new Date(), outcome: "INTERESTED" } });

    expect(await addReferral(attempt.id, { name: "Mike", phone: "555" })).toMatchObject({ ok: false });
    expect(await addReferral(attempt.id, { name: "Me", phone: "312 555 0102" })).toMatchObject({ ok: false });

    const t = await findToolAttempt({ attemptId: attempt.id });
    const r = await runAgentTool(t!, "record_referral", { name: "Mike Stone", phone: "(312) 555-0199", raw: "my buddy Mike" });
    expect(r).toMatchObject({ ok: true });
    const friend = await db.lead.findFirstOrThrow({ where: { phoneE164: "+13125550199" } });
    expect(friend).toMatchObject({ firstName: "Mike", lastName: "Stone", pipelineStatus: "NEW" });
    expect(await db.job.count({ where: { type: "lead.attempt-call" } })).toBe(0);
    expect(await db.task.count({ where: { leadId: friend.id, title: { contains: "Referred by Ray Cole" } } })).toBe(1);
    // Saying it twice changes nothing.
    await addReferral(attempt.id, { name: "Mike Stone", phone: "3125550199" });
    expect(await db.lead.count({ where: { phoneE164: "+13125550199" } })).toBe(1);

    expect((await referralsOf(lead.id)).map((f) => f.phoneE164)).toEqual(["+13125550199"]);
    expect(await referrerOf(friend.id)).toMatchObject({ leadId: lead.id, name: "Ray Cole" });

    await db.screeningField.create({ data: { leadId: lead.id, key: "experience_years", reportedValue: "5 years", rawUtterance: "5", status: "CAPTURED", callAttemptId: attempt.id } });
    expect(await buildCallReport(attempt.id)).toContain("🤝 Referral: Mike Stone +13125550199");
  });

  it("asks for referrals with the company's bonus", async () => {
    const base = await seedBase();
    const lead = await db.lead.create({ data: { orgId: base.org.id, campaignId: base.campaign.id, isDemo: true, firstName: "Ray", phoneE164: "+13125550102", timezone: "America/Chicago" } });
    const vars = await callVariables({ ...lead, permissions: [] }, "a1", "v1");
    expect(vars.referral_bonus).toBe("$500 referral bonus after 2 weeks of working with our company");
  });
});

describe("callback dates from the voice model", () => {
  it("moves a past date forward to the same weekday and time, drops far-future ones", async () => {
    const { fixCallbackYear } = await import("@/lib/calls");
    const now = new Date("2026-11-12T18:00:00Z"); // Thursday
    const fixed = fixCallbackYear(new Date("2024-01-15T16:00:00Z"), now)!; // Monday 10 AM CST
    expect(fixed.getTime()).toBeGreaterThan(now.getTime());
    expect(fixed.getTime() - now.getTime()).toBeLessThan(7 * 86400_000);
    expect(fixed.getUTCDay()).toBe(1);
    expect(fixed.getUTCHours()).toBe(16);
    expect(fixCallbackYear(new Date("2026-11-13T15:00:00Z"), now)?.toISOString()).toBe("2026-11-13T15:00:00.000Z");
    expect(fixCallbackYear(new Date("2027-06-01T15:00:00Z"), now)).toBeNull();
  });
});
