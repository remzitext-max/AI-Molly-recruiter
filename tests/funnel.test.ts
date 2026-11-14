import { describe, expect, it } from "vitest";
import { funnelSteps } from "@/lib/funnel";

describe("the dashboard's funnel row", () => {
  it("shows each of Crystal's steps as a share of the step before, Application and Hired as a share of all new leads", () => {
    const steps = funnelSteps({ newLeads: 326, called: 254, talked: 114, interested: 56, cdl: 18, application: 25, hired: 3 });
    expect(steps.map((s) => [s.label, s.n, s.pct, s.of])).toEqual([
      ["New leads", 326, null, "in this period"],
      ["Called by Crystal", 254, 78, "of new leads"],
      ["Talked to Crystal", 114, 45, "of called"],
      ["Interested", 56, 49, "of talked"],
      ["CDL received", 18, 32, "of interested"],
      ["Application", 25, 8, "of new leads"],
      ["Hired", 3, 1, "of new leads"],
    ]);
    // The divider stands before the recruiters' part.
    expect(steps.filter((s) => s.split).map((s) => s.label)).toEqual(["Application"]);
    // Every bar is the step's share of the new leads.
    expect(steps.map((s) => Math.round(s.bar))).toEqual([100, 78, 35, 17, 6, 8, 1]);
  });

  it("stays at zero when there is nothing to divide by", () => {
    const steps = funnelSteps({ newLeads: 0, called: 0, talked: 0, interested: 0, cdl: 0, application: 0, hired: 0 });
    expect(steps.map((s) => [s.n, s.pct, s.bar])).toEqual([[0, null, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    // New leads that Crystal did not call yet: no share of "called" to show for the steps after it.
    const waiting = funnelSteps({ newLeads: 4, called: 0, talked: 0, interested: 0, cdl: 0, application: 1, hired: 0 });
    expect(waiting.map((s) => s.pct)).toEqual([null, 0, 0, 0, 0, 25, 0]);
    expect(waiting[5].bar).toBe(25);
  });

  it("never draws a bar longer than the row", () => {
    const steps = funnelSteps({ newLeads: 1, called: 1, talked: 1, interested: 1, cdl: 1, application: 2, hired: 0 });
    expect(steps.every((s) => s.bar >= 0 && s.bar <= 100)).toBe(true);
    expect(steps[5].bar).toBe(100);
  });
});
