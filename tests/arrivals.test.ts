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
