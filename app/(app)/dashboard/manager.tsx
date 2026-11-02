// The manager's dashboard: the team's numbers for the period, every recruiter's lead
// sheet statuses (the same words as the sheet), the drivers Crystal talked to, the
// funnel and calls per day. The owner sees every team, with a row per team on top.
import Link from "next/link";
import { DateTime } from "luxon";
import type { Prisma, User } from "@prisma/client";
import { db } from "@/lib/db";
import { config } from "@/lib/config";
import { UPLOAD_PROVIDER } from "@/lib/recruiter-upload";
import { RECALL_PREFIX } from "@/lib/sheet-recall";
import { callsWithAnswers, groupCounts, isTalk, talkedDrivers, teamsScope } from "@/lib/talked";
import { countOf, orderStatuses, tabStats, talkedBy, type TabStats } from "@/lib/sheet-rows";
import { ON_PROCESS } from "@/lib/on-process";
import { statusTone } from "@/lib/recruiter-status";
import { ZONE, pct, type Period, type TeamView } from "@/lib/dashboard-view";
import { Card, Stat, initialsOf } from "@/components/ui";
import { BarRow, CallsChart, Delta } from "@/components/dash-parts";

const PLACED = { notIn: ["CANCELED", "SCHEDULED"] as ("CANCELED" | "SCHEDULED")[] };
const INTERESTED_UP = ["INTERESTED", "DOCS_REQUESTED", "DOCS_RECEIVED", "HANDOFF_READY", "HANDED_OFF"];
// Rough AI call cost per started minute (Telnyx line + agent), shown to the owner as an estimate.
const COST_PER_MIN = 0.06;
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mins = (m: number | null) => (m === null ? "—" : m < 1 ? "<1 min" : m < 60 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`);
// Old "No answer" leads re-called from the recruiters' tabs are not new applicants.
const fresh: Prisma.LeadWhereInput = { sourceRecords: { none: { sourceRecordId: { startsWith: RECALL_PREFIX } } } };
const sum = (tabs: TabStats[], f: (t: TabStats) => number) => tabs.reduce((n, t) => n + f(t), 0);

export async function ManagerDashboard({ user, view, p }: { user: Pick<User, "id" | "role" | "orgId">; view: TeamView; p: Period }) {
  const scope = teamsScope(view.orgIds, config.mode === "demo");
  const { range, prev } = p;
  const chartDays = Math.min(92, Math.max(14, p.days));
  const chartStart = p.to.minus({ days: chartDays - 1 });
  const calls = { lead: scope, provider: { not: UPLOAD_PROVIDER } };
  const distinctLeads = (where: Prisma.CallAttemptWhereInput) => db.callAttempt.findMany({ where, distinct: ["leadId"], select: { leadId: true } }).then((x) => x.length);

  const [newLeads, prevLeads, interested, prevInterested, docs, prevDocs, rangeLeads, chartCalls, calledDrivers, talkedList, tabs, onProcess] = await Promise.all([
    db.lead.count({ where: { ...scope, ...fresh, createdAt: range } }),
    db.lead.count({ where: { ...scope, ...fresh, createdAt: prev } }),
    distinctLeads({ ...calls, outcome: "INTERESTED", createdAt: range }),
    distinctLeads({ ...calls, outcome: "INTERESTED", createdAt: prev }),
    db.document.findMany({ where: { lead: scope, uploadedAt: range }, distinct: ["leadId"], select: { leadId: true } }).then((x) => x.length),
    db.document.findMany({ where: { lead: scope, uploadedAt: prev }, distinct: ["leadId"], select: { leadId: true } }).then((x) => x.length),
    db.lead.findMany({
      where: { ...scope, ...fresh, createdAt: range },
      select: { orgId: true, createdAt: true, pipelineStatus: true, documentStatus: true, hireStage: true, calls: { where: { status: PLACED }, orderBy: { createdAt: "asc" }, select: { id: true, createdAt: true, status: true, outcome: true } } },
    }),
    db.callAttempt.findMany({ where: { ...calls, status: PLACED, createdAt: { gte: chartStart.toJSDate(), lt: p.until } }, select: { id: true, createdAt: true, status: true, outcome: true, startedAt: true, endedAt: true } }),
    distinctLeads({ ...calls, status: PLACED, createdAt: range }),
    talkedDrivers(scope, range),
    tabStats(view.orgIds, range),
    db.sheetDriver.groupBy({ by: ["orgId"], where: { orgId: { in: view.orgIds } }, _count: true }),
  ]);
  const gave = await callsWithAnswers([...chartCalls, ...rangeLeads.flatMap((l) => l.calls)].map((c) => c.id));
  const talked = (c: { id: string; status?: string; outcome: string | null }) => isTalk(c, gave);

  const reached = sum(tabs, talkedBy), sheetTotal = sum(tabs, (t) => t.total);
  const applications = sum(tabs, (t) => countOf(t, "Application"));
  const sheetHired = sum(tabs, (t) => countOf(t, "Hired", "Our driver – working"));
  const onProcessNow = onProcess.reduce((n, o) => n + o._count, 0);
  const speed = median(rangeLeads.filter((l) => l.calls[0]).map((l) => (l.calls[0].createdAt.getTime() - l.createdAt.getTime()) / 60000));
  const cohortHired = rangeLeads.filter((l) => l.hireStage === "HIRED").length;

  const funnel = [
    { label: "New leads", n: newLeads },
    { label: "Called by Crystal", n: rangeLeads.filter((l) => l.calls[0]).length },
    { label: "Talked to Crystal", n: rangeLeads.filter((l) => l.calls.some(talked)).length },
    { label: "Interested", n: rangeLeads.filter((l) => INTERESTED_UP.includes(l.pipelineStatus)).length },
    { label: "CDL received", n: rangeLeads.filter((l) => l.documentStatus === "RECEIVED").length },
    { label: "Application", n: rangeLeads.filter((l) => ["APPLICATION", "ORIENTATION", "HIRED"].includes(l.hireStage)).length },
    { label: "Hired", n: cohortHired },
  ];

  const days = Array.from({ length: chartDays }, (_, i) => {
    const d = chartStart.plus({ days: i });
    return { key: d.toISODate()!, label: d.toFormat("MMM d"), answered: 0, other: 0 };
  });
  for (const c of chartCalls) {
    const day = days.find((d) => d.key === DateTime.fromJSDate(c.createdAt).setZone(ZONE).toISODate());
    if (day) (talked(c) ? day.answered++ : day.other++);
  }
  const groups = groupCounts(talkedList);
  const talkedHref = (group?: string) => `/talked?${new URLSearchParams({ since: p.since.toISOString(), until: p.until.toISOString(), who: "all", ...(view.team !== "all" && view.owner ? { team: view.team } : {}), ...(group ? { group } : {}) })}`;

  // The owner's row per team.
  const teamRows = view.owner && view.team === "all" ? await Promise.all(view.orgs.map(async (o) => {
    const t = tabs.filter((x) => tabsOf(x, o.id));
    const orgScope = teamsScope([o.id], config.mode === "demo");
    return {
      ...o,
      leads: rangeLeads.filter((l) => l.orgId === o.id).length,
      crystal: (await talkedDrivers(orgScope, range)).length,
      sheet: sum(t, (x) => x.total), reached: sum(t, talkedBy), application: sum(t, (x) => countOf(x, "Application")), hired: sum(t, (x) => countOf(x, "Hired", "Our driver – working")),
      onProcess: onProcess.find((x) => x.orgId === o.id)?._count ?? 0,
    };
  })) : [];

  const placedMins = chartCalls.filter((c) => c.createdAt >= p.since && c.createdAt < p.until && c.status === "COMPLETED")
    .reduce((s, c) => s + (c.startedAt && c.endedAt ? Math.max(1, Math.ceil((c.endedAt.getTime() - c.startedAt.getTime()) / 60000)) : 1), 0);

  return (
    <>
      {teamRows.length > 1 && (
        <div className="section">
          <Card title="Teams" flush>
            <div className="table-scroll">
              <table>
                <thead><tr><th>Team</th><th className="num">New leads</th><th className="num">Talked to Crystal</th><th className="num">Sheet leads</th><th className="num">Reached by recruiter</th><th className="num">On process now</th><th className="num">Application</th><th className="num">Hired</th></tr></thead>
                <tbody>
                  {teamRows.map((t) => (
                    <tr key={t.id} data-href={`/dashboard?team=${t.id}`} className="clickable">
                      <td><strong>{t.name}</strong></td>
                      <td className="num">{t.leads}</td><td className="num">{t.crystal}</td><td className="num">{t.sheet}</td>
                      <td className="num">{t.reached} <span className="muted">{pct(t.reached, t.sheet)}%</span></td>
                      <td className="num">{t.onProcess}</td><td className="num">{t.application}</td><td className="num">{t.hired}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted" style={{ margin: "8px 14px 12px" }}>Sheet columns count the drivers who applied in this period, by their status in each team&apos;s lead sheet now. Click a team for its dashboard.</p>
          </Card>
        </div>
      )}

      <div className="stats four">
        <Stat label="New leads" icon="leads" tone="blue" n={newLeads} sub={<Delta now={newLeads} prev={prevLeads} />} />
        <Stat label="Talked to Crystal" icon="voice" tone="teal" n={talkedList.length} sub={<>{pct(talkedList.length, calledDrivers)}% of {calledDrivers} drivers called · <Link href={talkedHref()}>see who</Link></>} />
        <Stat label="Reached by recruiters" icon="users" tone="violet" n={reached} sub={<>{pct(reached, sheetTotal)}% of {sheetTotal} sheet leads · status beyond New / No answer</>} />
        <Stat label="Interested" icon="star" tone="green" n={interested} sub={<Delta now={interested} prev={prevInterested} />} />
        <Stat label="CDL / med card in" icon="doc" tone="amber" n={docs} sub={<Delta now={docs} prev={prevDocs} />} />
        <Stat label="On process now" icon="check" tone="blue" n={onProcessNow} sub={<Link href="/process">{ON_PROCESS.join(", ")}</Link>} />
        <Stat label="Application" icon="jobs" tone="violet" n={applications} sub="sheet status, drivers who applied in this period" />
        <Stat label="Hired" icon="check" tone="green" n={sheetHired} sub="sheet status, drivers who applied in this period" />
      </div>

      <div className="section">
        <Leaderboard tabs={tabs} view={view} />
      </div>

      <div className="grid two section">
        <Card title={`Drivers Crystal talked to (${talkedList.length}): where they are now`} right={<Link className="small" href={talkedHref()}>See the list</Link>}>
          {groups.map((g) => <BarRow key={g.label} label={g.label} n={g.n} max={groups[0]?.n ?? 1} total={talkedList.length} href={talkedHref(g.label)} />)}
          {!talkedList.length && <p className="muted">Crystal has not talked to a driver in this period.</p>}
        </Card>
        <Card title="Funnel">
          {funnel.map((f, i) => <BarRow key={f.label} label={f.label} n={f.n} max={funnel[0].n} total={i ? funnel[0].n : undefined} cols="130px 1fr 80px" />)}
          <p className="small muted" style={{ margin: "10px 0 0" }}>Leads that came in during this period and how far each got. Speed to first call: {mins(speed)} (median).</p>
        </Card>
      </div>

      <div className={`grid ${view.owner ? "wide-left" : ""} section`}>
        <Card title="Crystal's calls per day" right={<div className="legend"><span><i style={{ background: "var(--series-1)" }} />Talked to driver</span><span><i style={{ background: "var(--series-muted)" }} />No answer or no real talk</span></div>}>
          <CallsChart days={days} />
        </Card>
        {view.owner && (
          <Card title="AI calling cost (estimate)">
            <div className="stat" style={{ border: 0, boxShadow: "none", padding: 0 }}>
              <div className="n">${(placedMins * COST_PER_MIN).toFixed(2)}</div>
              <div className="d">{placedMins} billed min at ~${COST_PER_MIN.toFixed(2)}/min, voicemail included</div>
            </div>
            <p className="small muted" style={{ margin: "8px 0 0" }}>Per driver talked to: {talkedList.length ? `$${((placedMins * COST_PER_MIN) / talkedList.length).toFixed(2)}` : "—"}. Telnyx billing has the exact spend.</p>
          </Card>
        )}
      </div>
    </>
  );
}

const tabsOf = (t: TabStats, orgId: string) => t.orgId === orgId;

/** Every recruiter's tab with the sheet's own statuses as columns. */
function Leaderboard({ tabs, view }: { tabs: TabStats[]; view: TeamView }) {
  const statuses = orderStatuses(tabs.flatMap((t) => Object.keys(t.byStatus)));
  const several = view.orgIds.length > 1;
  const teamName = new Map(view.orgs.map((o) => [o.id, o.name]));
  const rows = several ? [...tabs].sort((a, b) => view.orgIds.indexOf(a.orgId) - view.orgIds.indexOf(b.orgId)) : tabs;
  let lastTeam = "";
  return (
    <Card title="Recruiters: lead sheet statuses" flush right={<Link className="small" href={`/recruiters${view.owner && view.team !== "all" ? `?team=${view.team}` : ""}`} style={{ marginRight: 14 }}>Recruiter details →</Link>}>
      <div className="table-scroll">
        <table className="board">
          <thead><tr><th>Recruiter</th><th className="num">Leads</th><th className="num">Reached</th>{statuses.map((s) => <th key={s} className="num"><span className={`badge ${statusTone(s)}`}>{s}</span></th>)}</tr></thead>
          <tbody>
            {rows.map((t) => {
              const head = several && t.orgId !== lastTeam ? (lastTeam = t.orgId, <tr key={`h:${t.orgId}`} className="group-row"><td colSpan={statuses.length + 3}>{teamName.get(t.orgId) ?? ""}</td></tr>) : null;
              const who = t.recruiter ?? t.tab;
              return [head, (
                <tr key={`${t.orgId}:${t.tab}`}>
                  <td><div className="person"><div className="avatar">{initialsOf(who)}</div><div>{who}{t.recruiter && t.recruiter.toLowerCase() !== t.tab.toLowerCase() && <div className="small muted">{t.tab} tab</div>}{!t.recruiter && <div className="small muted">tab</div>}</div></div></td>
                  <td className="num"><strong>{t.total}</strong></td>
                  <td className="num">{pct(talkedBy(t), t.total)}%</td>
                  {statuses.map((s) => <td key={s} className={`num${t.byStatus[s] ? "" : " muted"}`}>{t.byStatus[s] ?? "·"}</td>)}
                </tr>
              )];
            })}
            {!rows.length && <tr><td colSpan={statuses.length + 3} className="muted">No lead sheet rows for drivers who applied in this period (the sheet is read every 15 minutes).</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ margin: "8px 14px 12px" }}>Drivers who applied in this period, by their status in the lead sheet now. Reached = any status beyond New, No answer and Not in service.</p>
    </Card>
  );
}
