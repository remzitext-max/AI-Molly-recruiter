import { beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { db } from "@/lib/db";
import { resetDb, seedBase } from "./helpers";
import { setAdapterOverride } from "@/adapters/registry";
import { createTeam } from "@/lib/teams";
import { pollTeamSheets, teamConnId } from "@/lib/team-sheets";
import { isOldApplication, parseApplied } from "@/lib/applied";
import { RETURNED, pickDayStart, waitingInPools } from "@/lib/old-leads";
import { appliedIn, firstSource, leadOrigin } from "@/lib/new-leads";
import { callVariables } from "@/lib/calls";
import { evaluateContactGate } from "@/lib/contact-policy";
import { getSettings } from "@/lib/settings";
import { backfillApplied } from "@/lib/applied-backfill";
import { reviveScan } from "@/lib/revive";

beforeEach(async () => { await resetDb(); });

const ZONE = "America/Chicago";
// The lead board's Applied column: US Central, "2026-09-23 15:55".
const applied = (minus: object) => DateTime.now().setZone(ZONE).minus(minus).toFormat("yyyy-MM-dd HH:mm");
const HEADERS = ["LeadID", "Applied", "Name", "Phone", "Experience"];
const LINK = "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#gid=77";

async function team() {
  const base = await seedBase();
  await db.campaign.update({ where: { id: base.campaign.id }, data: { isDemo: false } });
  const r = await createTeam(base.admin, { name: "Arslon team", managerName: "Sam", managerEmail: "sam@a.local", password: "x".repeat(12), sheetLink: LINK, transferPhone: "(314) 555-0101" });
  if (!("orgId" in r) || !r.orgId) throw new Error(JSON.stringify(r));
  const orgId: string = r.orgId;
  const camp = await db.campaign.findFirstOrThrow({ where: { orgId } });
  const rows: string[][] = [["A-0001", applied({ days: 90 }), "Was Here", "(602) 555-0100", "2 years"]];
  setAdapterOverride({ sheets: { readSheet: async () => ({ title: "Pool", headers: HEADERS, rows: [...rows], warnings: [] }) } as never });
  await pollTeamSheets(); // the first look only remembers what is in the Pool
  return { base, orgId, camp, rows };
}

describe("old leads that come back through the Pool", () => {
  it("knows an old application and the Central day", () => {
    const now = new Date("2026-11-12T23:30:00Z"); // 5:30 PM Central
    expect(isOldApplication(parseApplied("2026-11-12 08:57"), now)).toBe(false);
    expect(isOldApplication(parseApplied("11/10/2026 8:58:12"), now)).toBe(false); // 2 days
    expect(isOldApplication(parseApplied("2026-11-09 17:00"), now)).toBe(true); // 3 days
    expect(isOldApplication(parseApplied("2026-09-09 20:19"), now)).toBe(true);
    expect(isOldApplication(null, now)).toBe(false);
    // The daily numbers count from midnight Central (06:00 UTC in winter), not from midnight UTC.
    expect(pickDayStart(now).toISOString()).toBe("2026-11-12T06:00:00.000Z");
    expect(pickDayStart(new Date("2026-11-13T05:59:00Z")).toISOString()).toBe("2026-11-12T06:00:00.000Z");
    expect(pickDayStart(new Date("2026-11-13T06:00:00Z")).toISOString()).toBe("2026-11-13T06:00:00.000Z");
    expect(pickDayStart(new Date("2026-07-01T12:00:00Z")).toISOString()).toBe("2026-07-01T05:00:00.000Z"); // summer time
  });

  it("a row sent back to the Pool is an old lead: held while old leads are off, then a few a day, never as a new applicant", async () => {
    const { orgId, camp, rows } = await team();
    rows.unshift(
      ["A-1086", applied({ minutes: 2 }), "New Driver", "(602) 555-0111", "2 years"],
      ["A-0330", applied({ days: 60 }), "Back One", "(602) 555-0112", "1+ years"],
      ["A-0331", applied({ days: 60, hours: 1 }), "Low Exp", "(602) 555-0113", "less than 1 year "],
      ["A-0332", applied({ days: 59 }), "Six Months", "(602) 555-0114", "6+ months"],
      ["A-0274", applied({ days: 61 }), "Back Two", "(602) 555-0115", "1-2 years"],
      ["A-0273", applied({ days: 62 }), "Back Three", "(602) 555-0116", "3 years"],
    );
    const phones = async () => (await db.lead.findMany({ where: { orgId }, orderBy: { phoneE164: "asc" } })).map((l) => l.phoneE164.slice(-4));
    const summary = async () => (await db.sourceConnection.findUniqueOrThrow({ where: { id: teamConnId(orgId) } })).lastSummary;

    // Old leads off for the team: only the new applicant is taken.
    await pollTeamSheets();
    expect(await phones()).toEqual(["0111"]);
    expect(await summary()).toMatchObject({ oldRowsHeld: 5, oldRowsWaiting: 0 });
    const fresh = await db.lead.findFirstOrThrow({ where: { orgId }, select: { ...firstSource, reviveAt: true, reengagedAt: true, attemptCount: true, queueReason: true } });
    expect(fresh).toMatchObject({ reviveAt: null, reengagedAt: null, attemptCount: 0, queueReason: "New lead" });
    expect(leadOrigin(fresh)).toBe("applicant");
    expect(Math.abs(fresh.appliedAt!.getTime() - (Date.now() - 2 * 60_000))).toBeLessThan(61_000); // the sheet's Applied, Central

    // On, 2 a day: the two newest with a year or more of experience; the third waits for tomorrow.
    await db.campaign.update({ where: { id: camp.id }, data: { reviveEnabled: true, revivePerDay: 2 } });
    await pollTeamSheets();
    expect(await phones()).toEqual(["0111", "0112", "0115"]);
    expect(await summary()).toMatchObject({ oldRowsHeld: 3, oldRowsWaiting: 1 });
    expect(await waitingInPools(orgId)).toBe(1);
    await pollTeamSheets();
    expect(await phones()).toEqual(["0111", "0112", "0115"]); // today's number is used up

    const back = await db.lead.findFirstOrThrow({ where: { orgId, phoneE164: "+16025550112" }, include: { permissions: true, campaign: true, sourceRecords: { orderBy: { createdAt: "asc" }, take: 1, select: { sourceRecordId: true } } } });
    expect(back).toMatchObject({ reviveFrom: RETURNED, attemptCount: camp.maxAttempts - 2, queueReason: "Old lead back in the Pool", pipelineStatus: "QUEUED" });
    expect(back.reviveAt && back.reengagedAt).toBeTruthy();
    expect(leadOrigin(back)).toBe("returned");
    // Crystal says when they really applied and opens as a follow-up, not "a few minutes ago".
    expect(await callVariables(back, "att", "ov")).toMatchObject({ applied_when: "about 2 months ago", follow_up: "yes" });
    // New leads of today: the applicant only; the old ones belong to the day they applied.
    const today = { gte: pickDayStart(new Date()), lt: new Date(Date.now() + 60_000) };
    const counted = await db.lead.findMany({ where: { AND: [{ orgId }, appliedIn(today)] }, select: firstSource });
    expect(counted.filter((l) => leadOrigin(l) === "applicant")).toHaveLength(1);
    expect(await db.lead.count({ where: { orgId, reviveAt: today } })).toBe(2); // the "Old leads" card

    // Crystal's own picking leaves the waiting row its place the next day.
    await db.lead.updateMany({ where: { orgId, reviveAt: { not: null } }, data: { reviveAt: new Date(Date.now() - 86400_000) } });
    await db.sheetRow.createMany({ data: [1, 2, 3].map((n) => ({ orgId, phoneE164: `+1602555020${n}`, tab: "Tim", status: "No answer", appliedAt: new Date(Date.now() - 30 * 86400_000), statusAt: new Date(Date.now() - 30 * 86400_000), name: `Stuck ${n}` })) });
    process.env.APP_MODE = "live";
    try { expect(await reviveScan()).toEqual({ queued: 1 }); } finally { process.env.APP_MODE = "demo"; }
    await pollTeamSheets();
    expect(await phones()).toEqual(["0111", "0112", "0115", "0116", "0201"]);
  });

  it("a row that reached the site hours after the driver applied is not called outside the hours", async () => {
    const local = DateTime.now().setZone(ZONE).plus({ hours: 3 });
    const start = local.toFormat("HH:mm"), end = local.plus({ minutes: 1 }).toFormat("HH:mm");
    const base = await seedBase({ window: start < end ? [start, end] : ["03:00", "03:01"] });
    await db.campaign.update({ where: { id: base.campaign.id }, data: { hotCallMinutes: 15 } });
    const settings = await getSettings();
    const mk = async (phone: string, appliedAt: Date | null) => {
      const l = await db.lead.create({ data: { orgId: base.org.id, campaignId: base.campaign.id, isDemo: true, phoneE164: phone, timezone: ZONE, appliedAt,
        permissions: { create: { scope: "AI_CALL", source: "Test application form", grantedAt: new Date(Date.now() - 86400_000), isDemo: true } } }, include: { permissions: true, campaign: true } });
      const g = await evaluateContactGate({ lead: l, settings, channel: "CALL", now: new Date() });
      return g.ok ? "call now" : g.code;
    };
    expect(await mk("+13125550101", null)).toBe("call now"); // just arrived, no applied time: hot, as before
    expect(await mk("+13125550102", new Date(Date.now() - 60_000))).toBe("call now"); // applied a minute ago: hot
    expect(await mk("+13125550103", new Date(Date.now() - 2 * 3600_000))).toBe("call now"); // a sheet kept in Pacific time reads 2 hours early
    expect(await mk("+13125550104", new Date(Date.now() - 4 * 3600_000))).toBe("OUTSIDE_HOURS");
  });

  it("fills the applied date of earlier leads and moves the ones that came back through the Pool to old leads", async () => {
    const base = await seedBase();
    const DAY = 86400_000, created = new Date(Date.now() - 6 * 3600_000);
    const batch = (createdById: string, rows: string[][]) => db.importBatch.create({ data: { fileName: "Arslon team sheet: Pool", fileSha256: `${createdById}${rows.length}${rows[0][3]}`, sourceSystem: "GOOGLE_SHEETS@x", mapping: { phone: "Phone", sourceRecordId: "LeadID" }, rows: { headers: HEADERS, rows, warnings: [] }, campaignId: base.campaign.id, createdById, status: "COMMITTED" } });
    const sync = await batch("system", [["A-0330", applied({ days: 64 }), "Back One", "(602) 555-0112", ""], ["A-1086", DateTime.fromJSDate(created).setZone(ZONE).minus({ minutes: 1 }).toFormat("yyyy-MM-dd HH:mm"), "New Driver", "(602) 555-0111", ""]]);
    const reviewed = await batch(base.admin.id, [["A-0100", applied({ days: 40 }), "Old List", "(602) 555-0119", ""]]);
    const mk = (phone: string, src: { sourceRecordId: string; importBatchId?: string; raw: object }, more: object = {}) =>
      db.lead.create({ data: { orgId: base.org.id, campaignId: base.campaign.id, phoneE164: phone, createdAt: created, ...more, sourceRecords: { create: { sourceSystem: "GOOGLE_SHEETS@x", ...src } } } });
    const back = await mk("+16025550112", { sourceRecordId: "A-0330", importBatchId: sync.id, raw: { row: 2 } });
    const fresh = await mk("+16025550111", { sourceRecordId: "A-1086", importBatchId: sync.id, raw: { row: 9 } }); // wrong row number: found by phone
    const list = await mk("+16025550119", { sourceRecordId: "A-0100", importBatchId: reviewed.id, raw: { row: 2 } });
    const recall = await mk("+16025550120", { sourceRecordId: "recall:A-0200", raw: { applied: new Date(Date.now() - 20 * DAY).toISOString() } });
    const inSheet = await mk("+16025550121", { sourceRecordId: "phone:+16025550121", raw: {} });
    const again = await mk("+16025550122", { sourceRecordId: "phone:+16025550122", raw: {} });
    const unknown = await mk("+16025550123", { sourceRecordId: "phone:+16025550123", raw: {} });
    await db.sheetRow.createMany({ data: [
      { orgId: base.org.id, phoneE164: "+16025550121", tab: "Tim", status: "No answer", appliedAt: new Date(created.getTime() - 90_000) },
      { orgId: base.org.id, phoneE164: "+16025550122", tab: "Tim", status: "No answer", appliedAt: new Date(created.getTime() - 50 * DAY) }, // an earlier application of the same driver
    ] });

    expect(await backfillApplied()).toEqual({ checked: 7, filled: 5, returned: 1 });
    const get = (id: string) => db.lead.findUniqueOrThrow({ where: { id }, select: { ...firstSource, reviveAt: true, reviveFrom: true } });
    expect(await get(back.id)).toMatchObject({ reviveAt: created, reviveFrom: RETURNED });
    expect(leadOrigin(await get(back.id))).toBe("returned");
    const f = await get(fresh.id);
    expect(f).toMatchObject({ reviveAt: null, reviveFrom: null });
    expect(created.getTime() - f.appliedAt!.getTime()).toBeLessThan(121_000);
    expect(leadOrigin(f)).toBe("applicant");
    // An old list an admin imported on purpose stays what it was (no old-lead mark), but is no new applicant of that day.
    expect(await get(list.id)).toMatchObject({ reviveAt: null });
    expect(leadOrigin(await get(list.id))).toBe("returned");
    expect((await get(recall.id)).appliedAt).not.toBeNull();
    expect((await get(inSheet.id)).appliedAt).toEqual(new Date(created.getTime() - 90_000));
    expect((await get(again.id)).appliedAt).toBeNull();
    expect((await get(unknown.id)).appliedAt).toBeNull();
    expect(await backfillApplied()).toEqual({ checked: 2, filled: 0, returned: 0 }); // safe to run again
  });
});
