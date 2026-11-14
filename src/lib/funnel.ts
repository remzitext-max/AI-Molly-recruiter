// The funnel row at the top of the manager dashboard: the period's new leads and how far
// they got. Crystal's steps show their share of the step before; Application and Hired are
// the recruiters' results for every new lead (the numbers of the Application and Hired cards),
// so they show their share of all new leads.

export interface FunnelCounts { newLeads: number; called: number; talked: number; interested: number; cdl: number; application: number; hired: number }
export interface FunnelStep {
  label: string; n: number;
  /** Share of the new leads, 0..100: the length of the step's bar. */
  bar: number;
  /** The percent shown and what it is a share of; null for the first step, which only has `of`. */
  pct: number | null; of: string;
  /** A divider instead of an arrow before this step: the recruiters' part starts here. */
  split?: boolean;
}

const share = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);

export function funnelSteps(c: FunnelCounts): FunnelStep[] {
  const step = (label: string, n: number, base: number | null, of: string, split = false): FunnelStep => (
    { label, n, bar: c.newLeads ? Math.min(100, (n / c.newLeads) * 100) : 0, pct: base === null ? null : share(n, base), of, ...(split ? { split } : {}) }
  );
  return [
    step("New leads", c.newLeads, null, "in this period"),
    step("Called by Crystal", c.called, c.newLeads, "of new leads"),
    step("Talked to Crystal", c.talked, c.called, "of called"),
    step("Interested", c.interested, c.talked, "of talked"),
    step("CDL received", c.cdl, c.interested, "of interested"),
    step("Application", c.application, c.newLeads, "of new leads", true),
    step("Hired", c.hired, c.newLeads, "of new leads"),
  ];
}
