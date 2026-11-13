import { beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { db } from "@/lib/db";
import { resetDb, seedBase } from "./helpers";
import { setAdapterOverride } from "@/adapters/registry";
import { ingestLead } from "@/lib/leads";
import { applicationsOf, countNewLeads, newLeadsIn, onePerApplication, saveSheetApplications } from "@/lib/sheet-applications";
import { newLeadRow } from "@/lib/dashboard-lists";
import { tabStats } from "@/lib/sheet-rows";
import { callsWithAnswers, teamsScope } from "@/lib/talked";
import { period } from "@/lib/dashboard-view";
import { syncHiringFromSheet } from "@/lib/hiring";

beforeEach(async () => { await resetDb(); });

const ZONE = "America/Chicago";
const phone = (raw: string) => { const d = raw.replace(/\D/g, ""); return d.length === 10 ? `+1${d}` : null; };
const TAB = ["LeadID", "Applied", "Name", "Phone", "Status"];
const POOL = ["LeadID", "Applied", "Name", "Phone", "CLAIM →"];

describe("the lead sheet's applications", () => {
  it("reads every row with an Applied time, in a recruiter's tab or the Pool", () => {
    // Somebody wiped the "LeadID" header of this tab: the column before Applied still holds the ids.
    const tab = applicationsOf("Tim", ["", "Applied", "Name", "Phone", "Status"], [
      ["A-1086", "2026-11-12 08:57", "Will S", "(602) 555-0111", "Need to talk"],
      ["A-1083", "2026-11-11 18:02", "No Phone", "n/a", ""], // no valid phone: still a lead of that day
      ["", "2026-11-12 09:10", "No Id", "(602) 555-0112", "No answer"], // no LeadID: told by phone and time
      ["A-1090", "", "No Date", "(602) 555-0113", "New"], // no Applied time: not an application
      ["x", "2026-11-12 10:00", "", "", ""], // nothing to tell it by
    ], phone);
    expect(tab.map((a) => [a.key, a.phoneE164, a.status])).toEqual([
      ["A-1086", "+16025550111", "Need to talk"],
      ["A-1083", null, "New"],
      ["+16025550112|2026-11-12T15:10:00.000Z", "+16025550112", "No answer"],
    ]);
    expect(tab[0].appliedAt.toISOString()).toBe("2026-11-12T14:57:00.000Z"); // 08:57 US Central
    // The Pool has no Status column: its rows are new leads nobody has taken yet.
    expect(applicationsOf("📥 Pool", POOL, [["A-1091", "2026-11-12 11:00", "In Pool", "(602) 555-0114", ""]], phone)).toMatchObject([{ key: "A-1091", tab: "📥 Pool", status: "New", name: "In Pool" }]);
    expect(applicationsOf("📖 How to use", ["HOW TO USE THIS BOARD"], [["1. Claim a lead"]], phone)).toEqual([]);
    // A named LeadID column is taken as it is, whatever the ids look like.
    expect(applicationsOf("Ben", ["Lead ID", "Applied", "Phone", "Status"], [["77", "11/12/2026 8:58:12", "(602) 555-0115", "Hired"]], phone)).toMatchObject([{ key: "77", status: "Hired" }]);
  });

  it("counts a LeadID once: a recruiter's tab over the Pool, a worked status over No answer", () => {
    const at = new Date("2026-11-12T15:00:00Z");
    const row = (key: string, tab: string, status: string, p: string | null = "+16025550111") => ({ key, tab, status, phoneE164: p, name: null, appliedAt: at });
    const one = onePerApplication([
      row("A-1", "📥 Pool", "New"), row("A-1", "Jasmine", "Not qualified"),
      row("A-2", "Ben", "No answer", null), row("A-2", "Ben", "Not qualified", "+16025550112"),
      row("A-3", "Tim", "No answer"), row("A-3", "Tim", "No answer"),
    ]);
    expect(one.map((a) => [a.key, a.tab, a.status, a.phoneE164])).toEqual([["A-1", "Jasmine", "Not qualified", "+16025550111"], ["A-2", "Ben", "Not qualified", "+16025550112"], ["A-3", "Tim", "No answer", "+16025550111"]]);
  });

  it("keeps the saved applications the same as the sheet", async () => {
    const base = await seedBase();
    const at = new Date("2026-11-12T15:00:00Z");
    const row = (key: string, tab: string, status: string) => ({ key, tab, status, phoneE164: null, name: null, appliedAt: at });
    await saveSheetApplications(base.org.id, [row("S-1", "📥 Pool", "New"), row("S-2", "Ben", "No answer"), row("S-3", "Ben", "Hired")], true);
    // S-1 was claimed, S-3 was deleted from the sheet.
    await saveSheetApplications(base.org.id, [row("S-1", "Molly", "Call back"), row("S-2", "Ben", "No answer")], true);
    const saved = async () => (await db.sheetApplication.findMany({ where: { orgId: base.org.id }, orderBy: { key: "asc" } })).map((a) => [a.key, a.tab, a.status]);
    expect(await saved()).toEqual([["S-1", "Molly", "Call back"], ["S-2", "Ben", "No answer"]]);
    // A tab could not be read this time: nothing is dropped.
    await saveSheetApplications(base.org.id, [row("S-1", "Molly", "Application")], false);
    expect(await saved()).toEqual([["S-1", "Molly", "Application"], ["S-2", "Ben", "No answer"]]);
  });
});

describe("New leads on the dashboard = the sheet's rows for the day", () => {
  it("puts each row on the US Central day it applied, whatever day the site got it", async () => {
    const base = await seedBase();
    const scope = teamsScope([base.org.id], true);
    await saveSheetApplications(base.org.id, [
      ...applicationsOf("Ben", TAB, [
        ["S-1", "2026-11-11 23:30", "Late Evening", "(312) 555-0101", "No answer"], // 05:30 UTC on the 12th
        ["S-2", "2026-11-12 00:10", "After Midnight", "(312) 555-0102", "Need to talk"],
        ["S-3", "2026-11-12 23:59", "Last Minute", "(312) 555-0103", ""],
        ["S-4", "2026-11-13 00:00", "Next Day", "(312) 555-0104", ""],
        ["S-5", "2026-11-12 12:00", "Remzi Test", "(312) 555-0105", ""], // an owner test row
      ], phone),
      ...applicationsOf("📥 Pool", POOL, [["S-6", "2026-11-12 15:00", "Still In Pool", "(312) 555-0106", ""]], phone),
    ], true);
    const day = (d: string) => period({ from: d, to: d }, DateTime.fromISO("2026-11-20T12:00", { zone: ZONE }));
    const names = async (d: string) => (await newLeadsIn([base.org.id], scope, day(d).range)).map((n) => n.name);
    expect(await names("2026-11-11")).toEqual(["Late Evening"]);
    expect(await names("2026-11-12")).toEqual(["Last Minute", "Still In Pool", "After Midnight"]); // newest first
    expect(await names("2026-11-13")).toEqual(["Next Day"]);
    expect(await countNewLeads([base.org.id], scope, day("2026-11-12").prev)).toBe(1); // the day before
    // The recruiters' tabs and the Pool add up to the same number.
    const tabs = await tabStats([base.org.id], day("2026-11-12").range);
    expect(tabs.map((t) => [t.tab, t.total])).toEqual([["Ben", 2], ["📥 Pool", 1]]); // the owner's test row is in no count
  });

  it("counts every row of the day: the ones Crystal got through the Pool and the ones put straight into a recruiter's tab", async () => {
    const base = await seedBase();
    const scope = teamsScope([base.org.id], true);
    const now = DateTime.now().setZone(ZONE);
    const ago = (minus: object) => now.minus(minus).toFormat("yyyy-MM-dd HH:mm");
    const opts = { orgId: base.org.id, campaignId: base.campaign.id, isDemo: true, actorId: null, scheduleOutreach: false };
    const lead = async (id: string, p: string, applied: string | null) => {
      const r = await ingestLead({ sourceSystem: "GOOGLE_SHEETS", sourceRecordId: id, phone: p, firstName: "Drv", lastName: id, appliedAt: applied ? DateTime.fromFormat(applied, "yyyy-MM-dd HH:mm", { zone: ZONE }).toJSDate() : null }, opts);
      if (r.result !== "created") throw new Error(r.result);
      return r.leadId;
    };
    let k = 0;
    const call = (leadId: string, outcome: string | null, createdAt = new Date()) => db.callAttempt.create({ data: { leadId, isDemo: true, provider: "telnyx", idempotencyKey: `sa-${k++}`, status: "COMPLETED", outcome: outcome as never, createdAt } });

    // Through the Pool: the site made a lead of each within minutes, and a recruiter claimed it later.
    const a10 = ago({ minutes: 9 }), a11 = ago({ minutes: 8 });
    await lead("S-10", "(312) 555-0110", a10);
    const talked = await lead("S-11", "(312) 555-0111", a11);
    await call(talked, "INTERESTED");
    // The same driver applied a month ago and Crystal called then; today's row went straight to David.
    const again = await lead("S-02", "(312) 555-0113", ago({ days: 30 }));
    await db.lead.update({ where: { id: again }, data: { createdAt: now.minus({ days: 30 }).toJSDate() } });
    await call(again, "NOT_INTERESTED", now.minus({ days: 30 }).toJSDate());
    // An old lead a recruiter sent back to the Pool today: Crystal got it today, but it applied 60 days ago.
    await lead("A-0330", "(312) 555-0117", ago({ days: 60 }));
    const sheet = () => [
      ...applicationsOf("Molly", TAB, [["S-10", a10, "Got One", "(312) 555-0110", "No answer"], ["S-11", a11, "Got Two", "(312) 555-0111", "Need to talk"]], phone),
      ...applicationsOf("David", TAB, [
        ["T-12", ago({ minutes: 7 }), "Straight One", "(312) 555-0112", "Application"],
        ["T-13", ago({ minutes: 6 }), "Applied Again", "(312) 555-0113", "No answer"],
        ["S-02", ago({ days: 30 }), "Applied Again", "(312) 555-0113", "Not interested"],
      ], phone),
      ...applicationsOf("📥 Pool", POOL, [["T-14", ago({ minutes: 5 }), "No Phone", "n/a", ""], ["A-0330", ago({ days: 60 }), "Sent Back", "(312) 555-0117", ""]], phone),
    ];
    await saveSheetApplications(base.org.id, sheet(), true);
    // Imported from the Pool a minute ago: the 15-minute sheet reading has not seen its row yet.
    await lead("S-16", "(312) 555-0116", ago({ minutes: 1 }));

    const range = { gte: now.minus({ hours: 12 }).toJSDate(), lt: now.plus({ hours: 1 }).toJSDate() };
    const cohort = await newLeadsIn([base.org.id], scope, range);
    expect(cohort.map((n) => [n.name ?? n.lead?.lastName, n.tab, n.crystal, n.why])).toEqual([
      ["S-16", null, true, null], ["No Phone", "📥 Pool", false, "no_phone"], ["Applied Again", "David", false, "again"], ["Straight One", "David", false, "straight"], ["Got Two", "Molly", true, null], ["Got One", "Molly", true, null],
    ]);
    expect(await countNewLeads([base.org.id], scope, range)).toBe(6);

    const gave = await callsWithAnswers(cohort.flatMap((n) => n.lead?.calls ?? []).map((c) => c.id));
    const rows = cohort.map((n) => newLeadRow(n, gave, null, n.tab));
    const by = (name: string) => rows.find((r) => r.item.name === name)!;
    expect(by("Got Two")).toMatchObject({ crystal: true, called: true, talked: true, interested: true, reached: true, item: { sub: "Molly · Crystal: interested", badge: "Need to talk", tone: "ok" } });
    expect(by("Got One")).toMatchObject({ crystal: true, called: false, talked: false, reached: false, item: { sub: "Molly · Crystal: not called yet", tone: "late" }, sheetItem: { sub: "Molly", tone: "warn" } });
    expect(by("Straight One")).toMatchObject({ crystal: false, talked: false, reached: true, item: { leadId: null, sub: "David · straight to the recruiter, not through Crystal", badge: "Application", tone: "ok" } });
    // Last month's "not interested" was about the first application, not this one.
    expect(by("Applied Again")).toMatchObject({ crystal: false, talked: false, reached: false, item: { leadId: again, sub: "David · applied again, Crystal already had this driver", tone: "warn" } });
    expect(by("No Phone")).toMatchObject({ crystal: false, reached: false, item: { leadId: null, phone: "", badge: "New", sub: "📥 Pool · no valid phone number" } });
    expect(rows.filter((r) => r.crystal)).toHaveLength(3);
    expect(rows.filter((r) => r.talked)).toHaveLength(1);

    // Crystal re-calls the driver who applied again: shown on the row, counted on the re-calls card, not here.
    await call(again, "NO_CONTACT");
    const later = (await newLeadsIn([base.org.id], scope, range)).find((n) => n.name === "Applied Again")!;
    expect(newLeadRow(later, gave, "TBT", "David")).toMatchObject({ talked: false, called: false, item: { sub: "TBT · David · applied again, Crystal already had this driver · Crystal later: no answer, 1 call" } });

    // The sheet reading catches up: S-16's row stands for its lead now, and nothing is counted twice.
    await saveSheetApplications(base.org.id, [...sheet(), ...applicationsOf("📥 Pool", POOL, [["S-16", ago({ minutes: 1 }), "Just In", "(312) 555-0116", ""]], phone)], true);
    const after = await newLeadsIn([base.org.id], scope, range);
    expect(after).toHaveLength(6);
    expect(after[0]).toMatchObject({ name: "Just In", tab: "📥 Pool", crystal: true });
    expect((await tabStats([base.org.id], range)).reduce((n, t) => n + t.total, 0)).toBe(6);
    // The first application of the driver who applied again, and the old lead sent back, count on the days they applied.
    const month = { gte: now.minus({ days: 31 }).toJSDate(), lt: now.minus({ days: 29 }).toJSDate() };
    expect((await newLeadsIn([base.org.id], scope, month)).map((n) => [n.key.length > 0, n.name, n.crystal])).toEqual([[true, "Applied Again", true]]);
    const old = { gte: now.minus({ days: 61 }).toJSDate(), lt: now.minus({ days: 59 }).toJSDate() };
    expect((await newLeadsIn([base.org.id], scope, old)).map((n) => [n.name, n.crystal, n.why])).toEqual([["Sent Back", false, "before"]]);
  });

  it("a team whose sheet is read has exactly the sheet's rows, and says why a row was not Crystal's", async () => {
    const base = await seedBase();
    const scope = teamsScope([base.org.id], true);
    const now = DateTime.now().setZone(ZONE);
    const ago = (minus: object) => now.minus(minus).toFormat("yyyy-MM-dd HH:mm");
    const opts = { orgId: base.org.id, campaignId: base.campaign.id, isDemo: true, actorId: null, scheduleOutreach: false };
    const lead = async (sourceSystem: string, id: string, p: string, created?: Date, o = opts) => {
      const r = await ingestLead({ sourceSystem, sourceRecordId: id, phone: p, firstName: "Drv", lastName: id }, o);
      if (r.result !== "created") throw new Error(r.result);
      if (created) await db.lead.update({ where: { id: r.leadId }, data: { createdAt: created } });
      return r.leadId;
    };
    // Crystal started with this team 10 days ago.
    await lead("GOOGLE_SHEETS", "first", "(312) 555-0140", now.minus({ days: 10 }).toJSDate());
    // The same driver applied to another team's ad yesterday: that team keeps the driver.
    const other = await db.organization.create({ data: { name: "First team", isMain: false } });
    const theirs = await db.campaign.create({ data: { orgId: other.id, name: "First team", isDemo: true, offerId: base.offer.id, assignmentMode: "MANUAL", contactWindowStart: "00:00", contactWindowEnd: "23:59", contactDays: "1,2,3,4,5,6,7", maxAttempts: 3, retryDelayMinutes: 60 } });
    await lead("GOOGLE_SHEETS@x", "theirs", "(312) 555-0142", now.minus({ days: 1 }).toJSDate(), { ...opts, orgId: other.id, campaignId: theirs.id });
    const readAt = now.minus({ minutes: 10 }).toJSDate();
    await saveSheetApplications(base.org.id, [
      ...applicationsOf("Molly", TAB, [
        ["S-41", ago({ hours: 2 }), "Through Pool", "(312) 555-0141", "No answer"],
        ["S-42", ago({ hours: 3 }), "Other Team", "(312) 555-0142", "No answer"],
        ["T-43", ago({ hours: 4 }), "Team Lead", "(312) 555-0143", "Need to talk"],
        ["S-01", ago({ days: 20 }), "Before Crystal", "(312) 555-0144", "Not interested"],
      ], phone),
      ...applicationsOf("📥 Pool", POOL, [["S-45", ago({ hours: 5 }), "Old Row Waiting", "(312) 555-0145", ""]], phone),
    ], true, readAt);
    expect((await db.organization.findUniqueOrThrow({ where: { id: base.org.id } })).sheetReadAt).toEqual(readAt);
    await lead("GOOGLE_SHEETS", "S-41", "(312) 555-0141", now.minus({ hours: 2 }).toJSDate());
    // Not in the sheet: somebody's test of the YouTube lead form, and a lead whose row was deleted from the sheet.
    await lead("GOOGLE_ADS", "phone:3125550146", "(312) 555-0146", now.minus({ hours: 6 }).toJSDate());
    await lead("GOOGLE_SHEETS", "deleted", "(312) 555-0147", now.minus({ hours: 7 }).toJSDate());
    // Came in from the Pool after the last reading began: its row is waiting to be read.
    await lead("GOOGLE_SHEETS", "S-48", "(312) 555-0148");

    const range = { gte: now.minus({ hours: 12 }).toJSDate(), lt: now.plus({ hours: 1 }).toJSDate() };
    const cohort = await newLeadsIn([base.org.id], scope, range);
    expect(cohort.map((n) => [n.name ?? n.lead?.lastName, n.crystal, n.why])).toEqual([
      ["S-48", true, null], ["Through Pool", true, null], ["Other Team", false, "other_team"], ["Team Lead", false, "straight"], ["Old Row Waiting", false, "pool"],
    ]);
    const subs = cohort.map((n) => newLeadRow(n, new Set(), null, n.tab).item.sub);
    expect(subs.slice(2)).toEqual(["Molly · another team's driver first", "Molly · straight to the recruiter, not through Crystal", "📥 Pool · in the Pool, not taken by Crystal"]);
    const before = { gte: now.minus({ days: 21 }).toJSDate(), lt: now.minus({ days: 19 }).toJSDate() };
    expect((await newLeadsIn([base.org.id], scope, before)).map((n) => [n.name, n.why])).toEqual([["Before Crystal", "before"]]);
    // The other team has no sheet reading: its own lead is its new lead.
    expect((await newLeadsIn([other.id], teamsScope([other.id], true), { gte: now.minus({ days: 2 }).toJSDate(), lt: range.lt })).map((n) => n.lead?.lastName)).toEqual(["theirs"]);
  });

  it("a reading that lost most of the sheet drops nothing", async () => {
    const base = await seedBase();
    const at = new Date("2026-11-12T15:00:00Z");
    const many = Array.from({ length: 60 }, (_, i) => ({ key: `S-${1000 + i}`, tab: "Ben", status: "New", phoneE164: null, name: `Driver ${i}`, appliedAt: at }));
    await saveSheetApplications(base.org.id, many, true, new Date("2026-11-12T16:00:00Z"));
    await saveSheetApplications(base.org.id, many.slice(0, 5), true, new Date("2026-11-12T16:15:00Z"));
    expect(await db.sheetApplication.count({ where: { orgId: base.org.id } })).toBe(60);
    expect((await db.organization.findUniqueOrThrow({ where: { id: base.org.id } })).sheetReadAt).toEqual(new Date("2026-11-12T16:00:00Z"));
    // A few rows deleted from the sheet are followed.
    await saveSheetApplications(base.org.id, many.slice(0, 55), true, new Date("2026-11-12T16:30:00Z"));
    expect(await db.sheetApplication.count({ where: { orgId: base.org.id } })).toBe(55);
  });

  it("a team without a lead sheet keeps counting its own new applicants", async () => {
    const base = await seedBase();
    const scope = teamsScope([base.org.id], true);
    const opts = { orgId: base.org.id, campaignId: base.campaign.id, isDemo: true, actorId: null, scheduleOutreach: false };
    await ingestLead({ sourceSystem: "WEBHOOK", sourceRecordId: "fb-1", phone: "(312) 555-0120", firstName: "Web", lastName: "Lead" }, opts);
    await ingestLead({ sourceSystem: "GOOGLE_SHEETS", sourceRecordId: "recall:row-2", phone: "(312) 555-0121", firstName: "Re", lastName: "Call" }, opts);
    const range = { gte: new Date(Date.now() - 3600_000), lt: new Date(Date.now() + 1000) };
    expect((await newLeadsIn([base.org.id], scope, range)).map((n) => [n.lead?.firstName, n.tab, n.crystal])).toEqual([["Web", null, true]]);
  });
});

describe("the 15-minute sheet reading", () => {
  it("saves every tab's applications, the Pool included", async () => {
    const base = await seedBase();
    await db.organization.update({ where: { id: base.org.id }, data: { isMain: true } });
    const tabs: Record<string, { headers: string[]; rows: string[][] }> = {
      "📥 Pool": { headers: POOL, rows: [["S-0003", "2026-11-12 10:00", "In Pool", "(312) 555-0133", ""]] },
      Molly: { headers: ["", "Applied", "Name", "Phone", "Status"], rows: [["S-0001", "2026-11-12 08:00", "One", "(312) 555-0131", "Need to talk"], ["T-0002", "2026-11-11 21:00", "Two", "(312) 555-0132", ""]] },
      "📖 How to use": { headers: ["HOW TO USE THIS BOARD"], rows: [["Claim a lead in the Pool"]] },
    };
    setAdapterOverride({ sheets: {
      status: () => ({ kind: "lead_source", provider: "test", state: "configured", isMock: true, detail: "" }),
      listTabs: async () => Object.keys(tabs).map((title, i) => ({ title, gid: String(i) })),
      readSheet: async (t?: string) => ({ title: t!, ...tabs[t!], warnings: [] }),
    } as never });
    Object.assign(process.env, { APP_MODE: "live", GOOGLE_SHEETS_SPREADSHEET_ID: "SHEET" });
    try {
      const began = new Date();
      await syncHiringFromSheet();
      const saved = async () => (await db.sheetApplication.findMany({ where: { orgId: base.org.id }, orderBy: { key: "asc" } })).map((a) => [a.key, a.tab, a.status]);
      expect(await saved()).toEqual([["S-0001", "Molly", "Need to talk"], ["S-0003", "📥 Pool", "New"], ["T-0002", "Molly", "New"]]);
      // From now on the team's new leads are its sheet's rows.
      const readAt = (await db.organization.findUniqueOrThrow({ where: { id: base.org.id } })).sheetReadAt!;
      expect(readAt.getTime()).toBeGreaterThanOrEqual(began.getTime());
      expect(readAt.getTime()).toBeLessThanOrEqual(Date.now());
      // The Pool row is claimed by Molly; the next reading follows the sheet.
      tabs.Molly.rows.push(["S-0003", "2026-11-12 10:00", "In Pool", "(312) 555-0133", "No answer"]);
      tabs["📥 Pool"].rows = [];
      await syncHiringFromSheet();
      expect(await saved()).toEqual([["S-0001", "Molly", "Need to talk"], ["S-0003", "Molly", "No answer"], ["T-0002", "Molly", "New"]]);
    } finally {
      delete process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
      process.env.APP_MODE = "demo";
    }
  });
});
