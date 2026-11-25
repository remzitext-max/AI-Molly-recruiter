import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { arrivalStats, dayOf, parseDaily, parseOffice } from "@/lib/arrivals";

const now = DateTime.fromISO("2026-11-25T12:00:00", { zone: "America/Chicago" });

describe("office arrivals sheet", () => {
  it("finds the year of a day header from its weekday", () => {
    expect(dayOf(9, 1, now, "TUE")).toBe("2026-09-01");
    expect(dayOf(11, 23, now, "MONDAY")).toBe("2026-11-23");
    expect(dayOf(12, 29, now)).toBe("2025-12-29");
  });

  it("reads bookings under their day header and counts per recruiter", () => {
    const daily = [
      ["", "", "Driver Name", "Experience", "Number", "ETA", "Status", "Notes/Update", "Recruiter ", "", "Arrived at (auto)"],
      ["", "", "", "MON 11/23", "MON 11/23", "MON 11/23", "MON 11/23", "MON 11/23", "MON 11/23"],
      ["", "", "A ONE", "3 years", "(682) 308-8232", "9:00", "ARRIVED", "ORD", "DAVID"],
      ["", "", "B TWO", "", "(682) 308-8233", "9:00", "NO NEWS", "", "david"],
      ["", "", "", "", "", "", "", "", ""],
      ["", "", "C THREE", "", "(682) 308-8234", "", "ARRIVED", "", "Alex P"],
      ["", "", "", "WED 11/25", "WED 11/25", "WED 11/25", "WED 11/25", "WED 11/25", "WED 11/25"],
      ["", "", "D FOUR", "", "(682) 308-8235", "14:00", "", "", "ALEX P"],
    ];
    const office = [
      ["Arrived (date & time)", "Driver(s)", "Solo / Team", "Rate", "Experience", "Phone", "Recruiter", "x", "x", "x", "x", "x", "x", "x", "Status"],
      ["11/23 9:18 AM", "A ONE", "Solo", "", "", "", "DAVID", "", "", "", "", "", "", "", "Hit the road"],
      ["11/23 2:00 PM", "C THREE", "Solo", "", "", "", "ALEX P", "", "", "", "", "", "", "", "Declined at office"],
    ];
    const b = parseDaily(daily, now);
    expect(b.map((x) => [x.day, x.recruiter])).toEqual([["2026-11-23", "David"], ["2026-11-23", "David"], ["2026-11-23", "Alex P"], ["2026-11-25", "Alex P"]]);
    const s = arrivalStats(b, parseOffice(office, now), "2026-11-19", "2026-11-25", "2026-11-25");
    expect(s).toEqual([
      { recruiter: "Alex P", booked: 2, arrived: 1, noShow: 0, coming: 1, hitRoad: 0, left: 0, declined: 1 },
      { recruiter: "David", booked: 2, arrived: 1, noShow: 1, coming: 0, hitRoad: 1, left: 0, declined: 0 },
    ]);
  });
});

import { beforeEach } from "vitest";
import { db } from "@/lib/db";
import { arrivedLeads, arrivedNotHired, monthlyArrivals, parseBoardTab, type Booking } from "@/lib/arrivals";
import { resetDb, seedBase } from "./helpers";

describe("arrived but not hired", () => {
  beforeEach(async () => { await resetDb(); });
  it("lists our leads the office marked ARRIVED whose sheet status is not Hired", async () => {
    const { org } = await seedBase();
    await db.sheetRow.createMany({ data: [
      { orgId: org.id, phoneE164: "+16825550101", tab: "David", status: "Application", name: "Ann One" },
      { orgId: org.id, phoneE164: "+16825550102", tab: "David", status: "Hired", name: "Bob Two" },
      { orgId: org.id, phoneE164: "+16825550103", tab: "Molly", status: "Need approval", name: "Cara Three" },
    ] });
    const b = (name: string, phone: string | null, status = "ARRIVED", day = "2026-11-20"): Booking => ({ day, name, status, recruiter: "David", phone });
    const out = await arrivedNotHired([
      b("ANN ONE", "+16825550101"), // by phone, Application -> listed
      b("BOB TWO", "+16825550102"), // Hired -> not listed
      b("cara three", null), // no phone, by full name -> listed
      b("Dan Four", "+16825550104"), // not our lead
      b("Ann One", "+16825550101", "NO NEWS", "2026-11-21"), // not arrived
    ], "2026-11-01", "2026-11-25");
    expect(out.map((x) => [x.name, x.tab, x.status])).toEqual([["ANN ONE", "David", "Application"], ["cara three", "Molly", "Need approval"]]);
    const all = await arrivedLeads([b("ANN ONE", "+16825550101"), b("BOB TWO", "+16825550102", "ARRIVED", "2026-10-03"), b("cara three", null)], "2026-09-01", "2026-11-25");
    expect(monthlyArrivals(all)).toEqual([
      { month: "2026-10", arrived: 1, hired: 1, notMarked: 0, byTeam: { "Demo Freight": 1 } },
      { month: "2026-11", arrived: 2, hired: 0, notMarked: 2, byTeam: { "Demo Freight": 2 } },
    ]);
  });
});

describe("statistics-only board (Third team)", () => {
  beforeEach(async () => { await resetDb(); });
  it("reads lead rows and matches arrived drivers to it", async () => {
    await seedBase();
    const rows = parseBoardTab([
      ["LeadID", "Applied", "Name", "Phone", "Alt phone", "Status"],
      ["S-1", "2026-09-01 10:00", "Jeron Jordan", "(312) 555-0111", "", "Hired"],
      ["S-2", "2026-09-01 10:00", "Kay Zee", "(312) 555-0112", "", "No answer"],
    ], "Third team", "Martin");
    expect(rows).toHaveLength(2);
    const b = (name: string, phone: string): Booking => ({ day: "2026-09-15", name, status: "ARRIVED", recruiter: "Martin", phone });
    const out = await arrivedLeads([b("JERON JORDAN", "+13125550111"), b("KAY ZEE", "+13125550112")], "2026-09-01", "2026-09-30", rows);
    expect(out.map((x) => [x.name, x.team, x.tab, x.hired])).toEqual([["JERON JORDAN", "Third team", "Martin", true], ["KAY ZEE", "Third team", "Martin", false]]);
  });
});
