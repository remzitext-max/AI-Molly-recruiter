// "When drivers pick up" on the manager dashboard: Crystal's calls of the period laid out by
// US Central weekday and hour, and how many of each box became a talk. A talk is the same
// talk every other number counts (talked.ts).
import { DateTime } from "luxon";
import { ZONE } from "./dashboard-view";
import { isTalk } from "./talked";

/** A box shows its percent only from this many calls: fewer says nothing about the hour. */
export const MIN_CALLS = 20;
// The hours always shown (calls placed from 8 AM up to 10 PM). The table widens when an
// hour outside them has a box with MIN_CALLS calls, so a box that counts is never hidden.
const FIRST_HOUR = 8, LAST_HOUR = 21;
// Calls that went out and ended. A call that failed to start never rang; a live call has no result yet.
const ENDED = ["COMPLETED", "NO_ANSWER", "BUSY", "VOICEMAIL"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export interface HourCall { id: string; createdAt: Date; status: string; outcome: string | null; direction?: string | null }
export interface HourBox {
  hour: number; calls: number; talks: number;
  /** Percent of the calls that became a talk; null when the box has fewer than MIN_CALLS calls. */
  pct: number | null;
  /** 0 = too few calls; 1..5 = under 5%, 5-9%, 10-14%, 15-19%, 20% or more (by the percent shown). */
  step: number;
}

/** "8 AM", "12 PM", "9 PM"; hour 24 is midnight again. */
export const hourLabel = (h: number) => `${((h + 11) % 12) + 1} ${h % 24 < 12 ? "AM" : "PM"}`;

const stepOf = (pct: number) => (pct < 5 ? 1 : pct < 10 ? 2 : pct < 15 ? 3 : pct < 20 ? 4 : 5);

/** Crystal's outgoing calls by the Central weekday and hour she placed them. */
export function pickupHours(calls: HourCall[], gaveAnswers: Set<string>) {
  const grid = DAYS.map(() => Array.from({ length: 24 }, () => ({ calls: 0, talks: 0 })));
  for (const c of calls) {
    if ((c.direction ?? "OUTBOUND") !== "OUTBOUND" || !ENDED.includes(c.status)) continue;
    const at = DateTime.fromJSDate(c.createdAt).setZone(ZONE);
    const box = grid[at.weekday - 1][at.hour];
    box.calls++;
    if (isTalk(c, gaveAnswers)) box.talks++;
  }
  const counts = (h: number) => grid.some((day) => day[h].calls >= MIN_CALLS);
  let first = FIRST_HOUR, last = LAST_HOUR;
  for (let h = 0; h < FIRST_HOUR; h++) if (counts(h)) { first = h; break; }
  for (let h = 23; h > LAST_HOUR; h--) if (counts(h)) { last = h; break; }
  const hours = Array.from({ length: last - first + 1 }, (_, i) => first + i);

  const rows = DAYS.map((day, d) => ({
    day,
    boxes: hours.map((hour): HourBox => {
      const { calls: n, talks } = grid[d][hour];
      const pct = n >= MIN_CALLS ? Math.round((talks / n) * 100) : null;
      return { hour, calls: n, talks, pct, step: pct === null ? 0 : stepOf(pct) };
    }),
  }));
  const sum = (boxes: { calls: number; talks: number }[]) => boxes.reduce((t, x) => ({ calls: t.calls + x.calls, talks: t.talks + x.talks }), { calls: 0, talks: 0 });
  const shown = rows.flatMap((r) => r.boxes);
  const inTable = sum(shown), all = sum(grid.flat());
  return {
    hours, rows,
    /** Calls and talks inside the hours shown. */
    calls: inTable.calls, talks: inTable.talks,
    /** Calls placed in the hours the table does not show. */
    outside: all.calls - inTable.calls,
    /** Every call counted, whatever the hour. */
    all,
    /** Boxes with a percent, of all the boxes shown. */
    filled: shown.filter((x) => x.pct !== null).length, boxes: shown.length,
  };
}
export type PickupHours = ReturnType<typeof pickupHours>;
