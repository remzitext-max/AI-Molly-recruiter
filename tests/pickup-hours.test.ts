import { describe, expect, it } from "vitest";
import { MIN_CALLS, hourLabel, pickupHours, type HourCall } from "@/lib/pickup-hours";

let seq = 0;
const call = (at: string, over: Partial<HourCall> = {}): HourCall => ({ id: `c${seq++}`, createdAt: new Date(at), status: "NO_ANSWER", outcome: null, ...over });
const many = (n: number, at: string, over: Partial<HourCall> = {}) => Array.from({ length: n }, () => call(at, over));
const box = (r: ReturnType<typeof pickupHours>, day: string, hour: number) => r.rows.find((x) => x.day === day)!.boxes.find((b) => b.hour === hour)!;

describe("when drivers pick up", () => {
  it("puts a call in its US Central weekday and hour, before and after the clocks change", () => {
    const r = pickupHours([
      call("2026-11-10T02:30:00Z"), // Monday Nov 9, 8:30 PM Central (already Tuesday in UTC)
      call("2026-10-30T13:05:00Z"), // Friday 8:05 AM, daylight time (UTC-5)
      call("2026-11-06T14:05:00Z"), // Friday 8:05 AM, standard time (UTC-6)
      call("2026-11-08T17:59:59Z"), // Sunday 11:59 AM
    ], new Set());
    expect(box(r, "Mon", 20).calls).toBe(1);
    expect(box(r, "Fri", 8).calls).toBe(2);
    expect(box(r, "Sun", 11).calls).toBe(1);
    expect(r.calls).toBe(4);
    expect(r.hours).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    expect(r.rows.map((x) => x.day)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(r.boxes).toBe(98);
  });

  it("counts a talk the way the dashboard does: a decision, or an answer to a screening question", () => {
    const at = "2026-11-11T23:10:00Z"; // Wednesday 5:10 PM Central
    const gave = call(at, { status: "COMPLETED", outcome: "INCOMPLETE" });
    const r = pickupHours([
      call(at, { status: "COMPLETED", outcome: "INTERESTED" }),
      call(at, { status: "COMPLETED", outcome: "NOT_INTERESTED" }),
      call(at, { status: "COMPLETED", outcome: "CALLBACK" }),
      gave,
      call(at, { status: "COMPLETED", outcome: "INCOMPLETE" }), // picked up, said nothing that counts
      call(at, { status: "COMPLETED", outcome: "NO_CONTACT" }),
      call(at, { status: "VOICEMAIL", outcome: "VOICEMAIL_LEFT" }),
      call(at, { status: "BUSY" }),
      call(at),
    ], new Set([gave.id]));
    expect(box(r, "Wed", 17)).toMatchObject({ calls: 9, talks: 4, pct: null, step: 0 });
    expect(r.talks).toBe(4);
    expect(r.filled).toBe(0);
  });

  it("leaves out calls that never rang, calls still going and the calls drivers made themselves", () => {
    const at = "2026-11-11T23:10:00Z";
    const r = pickupHours([
      call(at),
      call(at, { status: "FAILED", outcome: "TECHNICAL_FAILURE" }),
      call(at, { status: "UNKNOWN" }),
      call(at, { status: "DIALING" }), call(at, { status: "RINGING" }), call(at, { status: "IN_PROGRESS" }),
      call(at, { status: "CANCELED" }), call(at, { status: "SCHEDULED" }),
      call(at, { status: "COMPLETED", outcome: "INTERESTED", direction: "INBOUND" }),
      call(at, { status: "COMPLETED", outcome: "INTERESTED", direction: "OUTBOUND" }),
    ], new Set());
    expect(box(r, "Wed", 17)).toMatchObject({ calls: 2, talks: 1 });
    expect(r).toMatchObject({ calls: 2, talks: 1, outside: 0 });
  });

  it("shows a percent only from 20 calls and colors the box by the percent shown", () => {
    const talk = { status: "COMPLETED", outcome: "INTERESTED" };
    const hour = (h: number) => `2026-11-12T${String(h + 6).padStart(2, "0")}:00:00Z`; // Thursday, Central hour h
    const r = pickupHours([
      ...many(MIN_CALLS - 1, hour(8)), // one call short
      ...many(MIN_CALLS, hour(9)), // 0 of 20
      ...many(19, hour(10)), ...many(1, hour(10), talk), // 1 of 20 = 5%
      ...many(21, hour(11)), ...many(1, hour(11), talk), // 1 of 22 = 4.5%, shown as 5%
      ...many(87, hour(12)), ...many(13, hour(12), talk), // 13%
      ...many(17, hour(13)), ...many(4, hour(13), talk), // 4 of 21 = 19%
      ...many(16, hour(14)), ...many(4, hour(14), talk), // 20%
      ...many(10, hour(15)), ...many(10, hour(15), talk), // 50%
    ], new Set());
    const got = (h: number) => { const b = box(r, "Thu", h); return [b.calls, b.talks, b.pct, b.step]; };
    expect(got(8)).toEqual([19, 0, null, 0]);
    expect(got(9)).toEqual([20, 0, 0, 1]);
    expect(got(10)).toEqual([20, 1, 5, 2]);
    expect(got(11)).toEqual([22, 1, 5, 2]);
    expect(got(12)).toEqual([100, 13, 13, 3]);
    expect(got(13)).toEqual([21, 4, 19, 4]);
    expect(got(14)).toEqual([20, 4, 20, 5]);
    expect(got(15)).toEqual([20, 10, 50, 5]);
    expect(r).toMatchObject({ filled: 7, boxes: 98, calls: 19 + 20 + 20 + 22 + 100 + 21 + 20 + 20, talks: 1 + 1 + 13 + 4 + 4 + 10 });
  });

  it("keeps the table at 8 AM to 10 PM and says how many calls fall outside it", () => {
    const r = pickupHours([
      ...many(5, "2026-11-12T12:30:00Z"), // Thursday 6:30 AM
      ...many(3, "2026-11-13T04:10:00Z"), // Thursday 10:10 PM
      call("2026-11-13T03:59:00Z"), // Thursday 9:59 PM, the last hour shown
      call("2026-11-12T14:00:00Z"), // Thursday 8:00 AM, the first hour shown
    ], new Set());
    expect(r.hours[0]).toBe(8);
    expect(r.hours.at(-1)).toBe(21);
    expect(r).toMatchObject({ calls: 2, outside: 8, all: { calls: 10, talks: 0 }, filled: 0 });
  });

  it("widens the table when an hour outside it has a box with 20 calls", () => {
    const r = pickupHours([
      ...many(MIN_CALLS, "2026-11-12T13:15:00Z"), // Thursday 7:15 AM
      ...many(MIN_CALLS, "2026-11-13T05:15:00Z", { status: "COMPLETED", outcome: "CALLBACK" }), // Thursday 11:15 PM
      ...many(4, "2026-11-12T10:00:00Z"), // Thursday 4:00 AM stays outside
    ], new Set());
    expect(r.hours[0]).toBe(7);
    expect(r.hours.at(-1)).toBe(23);
    expect(r).toMatchObject({ calls: 40, talks: 20, outside: 4, all: { calls: 44, talks: 20 }, filled: 2, boxes: 7 * 17 });
    expect(box(r, "Thu", 23)).toMatchObject({ pct: 100, step: 5 });
  });

  it("has nothing to show when no calls were placed", () => {
    expect(pickupHours([], new Set())).toMatchObject({ calls: 0, talks: 0, outside: 0, all: { calls: 0, talks: 0 }, filled: 0, boxes: 98 });
  });

  it("names the hours the way the table prints them", () => {
    expect([0, 8, 11, 12, 13, 21, 22, 24].map(hourLabel)).toEqual(["12 AM", "8 AM", "11 AM", "12 PM", "1 PM", "9 PM", "10 PM", "12 AM"]);
  });
});
