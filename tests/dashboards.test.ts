import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { addLead, resetDb, seedBase } from "./helpers";
import { onePerPhone, orderStatuses, parseApplied, saveSheetRows, sheetRowsOf, sheetStatus, tabStats, talkedBy } from "@/lib/sheet-rows";
import { markCallMade, scheduledByRecruiter, scheduledCalls } from "@/lib/scheduled-calls";
import { ringCentralHref } from "@/components/call-now";

beforeEach(async () => { await resetDb(); });

const phone = (raw: string) => { const d = raw.replace(/\D/g, ""); return d.length === 10 ? `+1${d}` : null; };

describe("lead sheet rows for the dashboards", () => {
  it("reads phone, status and applied date the way the sheet writes them", () => {
    const rows = sheetRowsOf("Molly", ["Applied", "Name", "Phone", "Status"], [
      ["10/30/2026 14:22:00", "A", "(214) 555-0101", "callback"],
      ["2026-10-31", "B", "214 555 0102", ""],
      ["", "C", "bad", "Hired"],
    ], phone);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ phoneE164: "+12145550101", tab: "Molly", status: "Call back" });
    expect(rows[0].appliedAt?.toISOString()).toBe("2026-10-30T19:22:00.000Z"); // US Central
    expect(rows[1].status).toBe("New"); // an empty cell is a new lead
    expect(sheetStatus("Something else")).toBe("Something else");
    expect(parseApplied("nonsense")).toBeNull();
  });

  it("keeps one row per phone: a recruiter's tab over the Pool, worked over No answer", () => {
    const at = new Date("2026-10-30T12:00:00Z");
    const one = onePerPhone([
      { phoneE164: "+1", tab: "Pool", status: "New", appliedAt: at },
      { phoneE164: "+1", tab: "Ben", status: "No answer", appliedAt: null },
      { phoneE164: "+1", tab: "Molly", status: "Application", appliedAt: null },
    ]);
    expect(one).toEqual([{ phoneE164: "+1", tab: "Molly", status: "Application", appliedAt: at, name: null, experience: null }]);
    expect(orderStatuses(["Hired", "Odd", "New", "Call back"])).toEqual(["New", "Call back", "Hired", "Odd"]);
  });

  it("counts every recruiter's tab by status for the period and names the recruiter", async () => {
    const base = await seedBase();
    const at = new Date("2026-10-30T15:00:00Z"), old = new Date("2026-09-01T15:00:00Z");
    await saveSheetRows(base.org.id, [
      { phoneE164: "+12145550101", tab: "Molly", status: "Application", appliedAt: at },
      { phoneE164: "+12145550102", tab: "Molly", status: "No answer", appliedAt: at },
      { phoneE164: "+12145550103", tab: "Molly", status: "Hired", appliedAt: old },
      { phoneE164: "+12145550104", tab: "Pool", status: "New", appliedAt: at },
    ]);
    const stats = await tabStats([base.org.id], { gte: new Date("2026-10-29T00:00:00Z"), lt: new Date("2026-11-01T00:00:00Z") });
    expect(stats.map((t) => [t.recruiter ?? t.tab, t.total])).toEqual([["Molly", 2], ["Pool", 1]]);
    expect(stats[0]).toMatchObject({ recruiterId: base.molly.id, byStatus: { Application: 1, "No answer": 1 } });
    expect(talkedBy(stats[0])).toBe(1);
    // The next read replaces the rows: gone phones go, changed ones change.
    await saveSheetRows(base.org.id, [{ phoneE164: "+12145550101", tab: "Molly", status: "Hired", appliedAt: at }]);
    expect(await db.sheetRow.findMany({ where: { orgId: base.org.id }, select: { status: true } })).toEqual([{ status: "Hired" }]);
  });
});

describe("booked recruiter calls", () => {
  it("stay on the recruiter's dashboard until the call is made", async () => {
    const base = await seedBase();
    const r = (await addLead(base)) as { leadId: string };
    const lead = await db.lead.findUniqueOrThrow({ where: { id: r.leadId } });
    const owner = lead.assignedToId === base.molly.id ? base.molly : base.alex;
    const other = owner.id === base.molly.id ? base.alex : base.molly;
    const due = new Date(Date.now() - 3600_000);
    await db.lead.update({ where: { id: lead.id }, data: { recruiterCallAt: due } });
    const t = await db.task.create({ data: { leadId: lead.id, type: "CALLBACK", title: "Call the driver", dueAt: due, assignedToId: owner.id, dedupeKey: "recruiter-call:a1" } });
    await db.task.create({ data: { leadId: lead.id, type: "CALLBACK", title: "Callback agreed", dueAt: due, assignedToId: owner.id, dedupeKey: "callback:a2" } });

    expect((await scheduledCalls(owner)).map((x) => x.id)).toEqual([t.id]);
    expect(await scheduledCalls(other)).toHaveLength(0);
    expect((await scheduledByRecruiter([base.org.id])).get(owner.id)).toEqual({ open: 1, late: 1 });
    await expect(markCallMade(other, t.id)).rejects.toThrow(/No access/);
    await markCallMade(owner, t.id);
    expect(await scheduledCalls(owner)).toHaveLength(0);
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).recruiterCallAt).toBeNull();
  });

  it("opens RingCentral with the number typed in", () => {
    expect(ringCentralHref("+13145550101", false)).toBe("rcapp://r/call?number=13145550101");
    expect(ringCentralHref("+13145550101", true)).toBe("rcmobile://call?number=13145550101");
  });
});

describe("the board", () => {
  it("counts each status, marks stuck drivers and shows a recruiter only their tab", async () => {
    const { loadBoard, toneOf } = await import("@/lib/board");
    const base = await seedBase();
    const now = new Date("2026-11-02T20:00:00Z"), day = 86400_000;
    await saveSheetRows(base.org.id, [
      { phoneE164: "+12145550101", tab: "Molly", status: "Need to bring", appliedAt: new Date(now.getTime() - 9 * day), name: "Ken Wu", experience: "3 years" },
      { phoneE164: "+12145550102", tab: "Molly", status: "Need to bring", appliedAt: new Date(now.getTime() - 1 * day) },
      { phoneE164: "+12145550103", tab: "Alex", status: "Application", appliedAt: new Date(now.getTime() - 2 * day) },
      { phoneE164: "+12145550104", tab: "Pool", status: "New", appliedAt: new Date(now.getTime() - 2 * day) },
      { phoneE164: "+12145550105", tab: "Pool", status: "New", appliedAt: new Date(now.getTime() - 60 * day) },
      { phoneE164: "+12145550106", tab: "Molly", status: "No answer", appliedAt: now },
    ], new Date(now.getTime() - 9 * day));
    const admin = await db.user.findFirstOrThrow({ where: { orgId: base.org.id, role: "ADMIN" } });
    const all = await loadBoard(admin, [base.org.id], undefined, now);
    const col = (s: string, b = all) => b.columns.find((c) => c.status === s)!;
    expect(col("Need to bring").drivers.map((d) => [d.name, d.tone])).toEqual([["Ken Wu", "late"], ["(no name)", "ok"]]);
    expect(col("Need to bring").lateText).toBe("1 stuck 5d+");
    expect(col("New").drivers).toHaveLength(1); // the 60-day-old one is not new any more
    expect(col("Application").drivers[0].recruiterId).toBe(base.alex.id);
    const mine = await loadBoard(base.molly, [base.org.id], undefined, now);
    expect(mine.columns.flatMap((c) => c.drivers).map((d) => d.phone).sort()).toEqual(["+12145550101", "+12145550102"]);
    expect(toneOf("Need approval", 2.5 * day)).toBe("warn");
  });

  it("lists the drivers behind the Application / Hired numbers (applied in the period)", async () => {
    const { sheetDrivers } = await import("@/lib/board");
    const base = await seedBase();
    const now = new Date("2026-11-03T18:00:00Z"), day = 86400_000;
    await saveSheetRows(base.org.id, [
      { phoneE164: "+12145550111", tab: "Alex", status: "Application", appliedAt: new Date(now.getTime() - 2 * day), name: "In Range" },
      { phoneE164: "+12145550112", tab: "Alex", status: "Application", appliedAt: new Date(now.getTime() - 20 * day), name: "Too Old" },
      { phoneE164: "+12145550113", tab: "Molly", status: "Our driver – working", appliedAt: new Date(now.getTime() - 3 * day), name: "Working Now" },
      { phoneE164: "+12145550114", tab: "Molly", status: "Need to bring", appliedAt: new Date(now.getTime() - 1 * day) },
    ], now);
    const range = { gte: new Date(now.getTime() - 7 * day), lt: now };
    const apps = await sheetDrivers([base.org.id], ["Application"], range, now);
    expect(apps.map((d) => [d.name, d.recruiterId])).toEqual([["In Range", base.alex.id]]);
    const hired = await sheetDrivers([base.org.id], ["Hired", "Our driver – working"], range, now);
    expect(hired.map((d) => d.name)).toEqual(["Working Now"]);
  });
});
