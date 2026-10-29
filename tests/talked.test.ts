import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { addLead, resetDb, seedBase } from "./helpers";
import { dashboardScope, groupCounts, talkedDrivers } from "@/lib/talked";

beforeEach(async () => { await resetDb(); });

describe("drivers Crystal talked to", () => {
  it("counts each driver once, not a bare name check, and shows where each one is now", async () => {
    const base = await seedBase();
    const lead = async (phone: string, status?: string) => {
      const r = await addLead(base, { phone });
      if (r.result !== "created") throw new Error("no lead");
      // "Test" last names are owner tests the dashboard leaves out.
      await db.lead.update({ where: { id: r.leadId }, data: { lastName: "Driver", recruiterStatus: status ?? null } });
      return r.leadId;
    };
    let n = 0;
    const call = async (leadId: string, outcome: string | null, answers: string[] = []) => {
      const c = await db.callAttempt.create({ data: { leadId, isDemo: true, provider: "telnyx", idempotencyKey: `t-${n++}`, status: "COMPLETED", outcome: outcome as never } });
      for (const key of answers) await db.screeningField.upsert({ where: { leadId_key: { leadId, key } }, create: { leadId, key, reportedValue: "x", callAttemptId: c.id }, update: { callAttemptId: c.id } });
    };
    const declined = await lead("(214) 555-0181", "Declined");
    await call(declined, "INCOMPLETE", ["experience_years"]);
    await call(declined, "INTERESTED"); // two talks, one driver
    const crystalNo = await lead("(214) 555-0182");
    await call(crystalNo, "NOT_INTERESTED");
    const nameOnly = await lead("(214) 555-0183");
    await call(nameOnly, "INCOMPLETE", ["first_name", "english_level"]); // "yes, this is John", then hung up

    const stale = await lead("(214) 555-0184", "No answer"); // re-called from a recruiter tab, talked to Crystal
    await call(stale, "INTERESTED");
    const list = await talkedDrivers(dashboardScope(base.admin, false, true), { gte: new Date(Date.now() - 3600_000), lt: new Date(Date.now() + 1000) });
    expect(list.map((d) => d.leadId).sort()).toEqual([declined, crystalNo, stale].sort());
    expect(groupCounts(list)).toEqual(expect.arrayContaining([{ label: "Declined", n: 1 }, { label: "Not interested (Crystal's call)", n: 1 }, { label: 'Interested (Crystal\'s call) · sheet still "No answer"', n: 1 }]));
    expect(list.find((d) => d.leadId === declined)?.crystal).toBe("Interested (Crystal's call)");
  });
});
