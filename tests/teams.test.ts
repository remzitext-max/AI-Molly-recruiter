import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { addLead, resetDb, seedBase } from "./helpers";
import { setAdapterOverride } from "@/adapters/registry";
import { createTeam, updateTeam } from "@/lib/teams";
import { parseSheetLink, pollTeamSheets, teamConnId } from "@/lib/team-sheets";
import { teamTransfer } from "@/lib/recruiter-tab";
import { isOwner } from "@/lib/auth";
import { companyName } from "@/lib/company";
import { syncHiringFromSheet } from "@/lib/hiring";

beforeEach(async () => { await resetDb(); });

const LINK = "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#gid=77";

describe("recruiting teams", () => {
  it("reads the sheet id and Pool tab from a pasted link", () => {
    expect(parseSheetLink(LINK)).toEqual({ spreadsheetId: "1AbCdEfGhIjKlMnOpQrStUvWxYz012345", tab: "gid:77" });
    expect(parseSheetLink("not a link")).toBeNull();
  });

  it("gets its own campaign, manager and leads; Crystal calls only new Pool rows and transfers to the team's number", async () => {
    const base = await seedBase();
    await db.campaign.update({ where: { id: base.campaign.id }, data: { isDemo: false } });
    const r = await createTeam(base.admin, { name: "First team", managerName: "Sam", managerEmail: "Sam@First.local", password: "x".repeat(12), sheetLink: LINK, transferPhone: "(314) 555-0101" });
    if (!("orgId" in r)) throw new Error(JSON.stringify(r));
    const org = await db.organization.findUniqueOrThrow({ where: { id: r.orgId }, include: { campaigns: true, users: true } });
    expect(org).toMatchObject({ isMain: false, sheetPoolTab: "gid:77", transferPhoneE164: "+13145550101", telegramChatId: null });
    expect(org.campaigns[0].offerId).toBe(base.offer.id);
    expect(org.users[0]).toMatchObject({ email: "sam@first.local", role: "ADMIN" });
    expect(await isOwner(org.users[0])).toBe(false);
    expect(await isOwner(base.admin)).toBe(true);
    expect(await companyName(org)).toBe("Demo Freight"); // drivers hear the company, not the team
    // A team with its own company ("Arslon LLC") is called and texted in that name.
    await updateTeam(base.admin, org.id, { name: "First team", sheetLink: LINK, transferPhone: "(314) 555-0101", companyName: " Arslon LLC " });
    expect(await companyName(await db.organization.findUniqueOrThrow({ where: { id: org.id } }))).toBe("Arslon LLC");
    await updateTeam(base.admin, org.id, { name: "First team", sheetLink: LINK, transferPhone: "(314) 555-0101", companyName: "" });
    expect(await companyName(await db.organization.findUniqueOrThrow({ where: { id: org.id } }))).toBe("Demo Freight");

    const mine = await addLead(base, { phone: "(214) 555-0177" });
    if (mine.result !== "created") throw new Error("no lead");
    await db.lead.update({ where: { id: mine.leadId }, data: { isDemo: false } });

    const rows = [["Old Pool row", "(602) 555-0100"]];
    const asked: (string | undefined)[] = [];
    setAdapterOverride({ sheets: { readSheet: async (range?: string, id?: string) => { asked.push(`${id} ${range}`); return { title: "Pool", headers: ["Name", "Phone"], rows: [...rows], warnings: [] }; } } as never });
    await pollTeamSheets();
    expect(asked).toEqual(["1AbCdEfGhIjKlMnOpQrStUvWxYz012345 gid:77"]);
    expect(await db.lead.count({ where: { orgId: org.id } })).toBe(0); // rows already there are never called

    rows.push(["New Driver", "(602) 555-0111"], ["Already ours", "(214) 555-0177"]);
    await pollTeamSheets();
    const theirs = await db.lead.findMany({ where: { orgId: org.id } });
    expect(theirs.map((l) => l.phoneE164)).toEqual(["+16025550111"]); // our driver is not called twice
    expect(theirs[0].campaignId).toBe(org.campaigns[0].id);
    expect(await db.lead.count({ where: { orgId: base.org.id } })).toBe(1);

    expect(await teamTransfer(theirs[0].id)).toEqual({ target: "team_First_team", phone: "+13145550101" });
    expect(await teamTransfer(mine.leadId)).toBeNull();

    // Another Pool tab: its rows are remembered again, not called.
    await updateTeam(base.admin, org.id, { name: "First team", sheetLink: LINK.replace("gid=77", "gid=78"), transferPhone: "+13145550101" });
    expect(await db.sourceConnection.findUnique({ where: { id: teamConnId(org.id) } })).toBeNull();
  });

  it("refuses a bad Telegram chat id or phone", async () => {
    const base = await seedBase();
    await db.campaign.update({ where: { id: base.campaign.id }, data: { isDemo: false } });
    const t = { name: "T", managerName: "A", managerEmail: "a@b.local", password: "x".repeat(12) };
    expect(await createTeam(base.admin, { ...t, telegramChatId: "@group" })).toEqual({ error: "Telegram chat id is a number like -1001234567890" });
    const ok = await createTeam(base.admin, { ...t, telegramChatId: "1004453731090" });
    if (!("orgId" in ok)) throw new Error("not created");
    expect((await db.organization.findUniqueOrThrow({ where: { id: ok.orgId } })).telegramChatId).toBe("-1004453731090");
    expect(await createTeam(base.admin, { ...t, managerEmail: "c@b.local", transferPhone: "123" })).toEqual({ error: "Transfer number is not a valid US phone number" });
  });

  it("re-calls the team's old 'No answer' drivers with the team's own campaign, never another team's driver", async () => {
    const base = await seedBase();
    await db.campaign.update({ where: { id: base.campaign.id }, data: { isDemo: false } });
    const r = await createTeam(base.admin, { name: "First team", managerName: "Andy", managerEmail: "andy@first.local", password: "x".repeat(12), sheetLink: LINK });
    if (!("orgId" in r)) throw new Error(JSON.stringify(r));
    expect(await updateTeam(base.admin, r.orgId!, { name: "First team", sheetLink: LINK, recall: { minDays: 60, maxDays: 7, perDay: 5 } })).toEqual({ error: "Re-call days: the second number must be bigger than the first" });
    await updateTeam(base.admin, r.orgId!, { name: "First team", sheetLink: LINK, recall: { minDays: 7, maxDays: 60, perDay: 5 } });
    const camp = await db.campaign.findFirstOrThrow({ where: { orgId: r.orgId } });
    expect(camp).toMatchObject({ recallMinDays: 7, recallMaxDays: 60, recallPerDay: 5 });

    const ours = await addLead(base, { phone: "(312) 555-0209" });
    if (ours.result !== "created") throw new Error("no lead");
    await db.lead.update({ where: { id: ours.leadId }, data: { isDemo: false } });
    const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();
    const headers = ["Applied", "Name", "Phone", "Status"];
    const tabs: Record<string, string[][]> = {
      Sora: [[day(10), "Ten Days", "(312) 555-0201", "No answer"], [day(3), "Too New", "(312) 555-0202", "No answer"], [day(20), "Company Driver", "(312) 555-0209", "No answer"]],
      David: [[day(30), "Thirty Days", "(312) 555-0203", "No answer"], [day(25), "Worked Twice", "(312) 555-0204", "No answer"]],
      Andy: [[day(5), "Worked Twice", "(312) 555-0204", "Call back"]],
    };
    setAdapterOverride({ sheets: {
      idColumn: "Phone",
      status: () => ({ kind: "lead_source", provider: "test", state: "configured", isMock: true, detail: "" }),
      listTabs: async (id?: string) => (id === "SHEET" ? [] : Object.keys(tabs).map((title, i) => ({ title, gid: String(i + 1) }))),
      readSheet: async (title: string) => ({ title, headers, rows: tabs[title] ?? [], warnings: [] }),
    } as never });
    Object.assign(process.env, { APP_MODE: "live", GOOGLE_SHEETS_SPREADSHEET_ID: "SHEET" });
    try {
      expect(await syncHiringFromSheet()).toMatchObject({ recalled: 2 });
      const leads = await db.lead.findMany({ where: { orgId: r.orgId }, include: { sourceRecords: true } });
      expect(leads.map((l) => l.firstName).sort()).toEqual(["Ten", "Thirty"]);
      for (const l of leads) {
        expect(l.campaignId).toBe(camp.id);
        expect(l.sourceRecords[0].sourceRecordId).toMatch(/^recall:/);
      }
      expect(await db.lead.count({ where: { orgId: base.org.id } })).toBe(1); // the company's driver stays the company's
      expect(await syncHiringFromSheet()).toMatchObject({ recalled: 0 });
    } finally {
      delete process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
      process.env.APP_MODE = "demo";
    }
  });
});
