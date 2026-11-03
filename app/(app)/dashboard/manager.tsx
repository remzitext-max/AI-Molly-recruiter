// The manager's dashboard: the team's results for the period, the drivers who need a push
// (stuck in a status, from the Board), the recruiters, the funnel and booked calls. The
// owner sees every team (a Teams table and the top recruiters) and the money block.
import Link from "next/link";
import { DateTime } from "luxon";
import type { Prisma, User } from "@prisma/client";
import { db } from "@/lib/db";
import { config } from "@/lib/config";
import { UPLOAD_PROVIDER } from "@/lib/recruiter-upload";
import { RECALL_PREFIX } from "@/lib/sheet-recall";
import { callsWithAnswers, isTalk, talkedDrivers, teamsScope } from "@/lib/talked";
import { countOf, orderStatuses, tabStats, talkedBy, type TabStats } from "@/lib/sheet-rows";
import { ON_PROCESS } from "@/lib/on-process";
import { statusTone } from "@/lib/recruiter-status";
import { ZONE, pct, type Period, type TeamView } from "@/lib/dashboard-view";
import { Card, Stat, initialsOf } from "@/components/ui";
import { BoardStrip, DriverStat } from "@/components/board-strip";
import { loadBoard, sheetDrivers, stuckColumns, type BoardDriver } from "@/lib/board";
import { scheduledCalls } from "@/lib/scheduled-calls";
import { BarRow, Delta } from "@/components/dash-parts";

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
  const calls = { lead: scope, provider: { not: UPLOAD_PROVIDER } };
  const distinctLeads = (where: Prisma.CallAttemptWhereInput) => db.callAttempt.findMany({ where, distinct: ["leadId"], select: { leadId: true } }).then((x) => x.length);

  const [newLeads, prevLeads, rangeLeads, chartCalls, calledDrivers, talkedList, tabs, onProcess] = await Promise.all([
    db.lead.count({ where: { ...scope, ...fresh, createdAt: range } }),
    db.lead.count({ where: { ...scope, ...fresh, createdAt: prev } }),
    db.lead.findMany({
      where: { ...scope, ...fresh, createdAt: range },
      select: { orgId: true, createdAt: true, pipelineStatus: true, documentStatus: true, hireStage: true, calls: { where: { status: PLACED }, orderBy: { createdAt: "asc" }, select: { id: true, createdAt: true, status: true, outcome: true } } },
    }),
    db.callAttempt.findMany({ where: { ...calls, status: PLACED, createdAt: range }, select: { id: true, createdAt: true, status: true, outcome: true, startedAt: true, endedAt: true } }),
    distinctLeads({ ...calls, status: PLACED, createdAt: range }),
    talkedDrivers(scope, range),
    tabStats(view.orgIds, range),
    db.sheetDriver.groupBy({ by: ["orgId"], where: { orgId: { in: view.orgIds } }, _count: true }),
  ]);
  const gave = await callsWithAnswers([...chartCalls, ...rangeLeads.flatMap((l) => l.calls)].map((c) => c.id));
  const talked = (c: { id: string; status?: string; outcome: string | null }) => isTalk(c, gave);

  const reached = sum(tabs, talkedBy), sheetTotal = sum(tabs, (t) => t.total);
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

  const talkedHref = (group?: string) => `/talked?${new URLSearchParams({ since: p.since.toISOString(), until: p.until.toISOString(), who: "all", ...(view.team !== "all" && view.owner ? { team: view.team } : {}), ...(group ? { group } : {}) })}`;

  // The owner's row per team.
  const teamRows = view.owner && view.team === "all" ? view.orgs.map((o) => {
    const t = tabs.filter((x) => tabsOf(x, o.id));
    const mine = rangeLeads.filter((l) => l.orgId === o.id);
    return {
      ...o,
      leads: mine.length,
      called: mine.filter((l) => l.calls[0]).length,
      crystal: mine.filter((l) => l.calls.some(talked)).length,
      sheet: sum(t, (x) => x.total), reached: sum(t, talkedBy), application: sum(t, (x) => countOf(x, "Application")), hired: sum(t, (x) => countOf(x, "Hired", "Our driver – working")),
      onProcess: onProcess.find((x) => x.orgId === o.id)?._count ?? 0,
    };
  }) : [];

  const placedMins = chartCalls.filter((c) => c.createdAt >= p.since && c.createdAt < p.until && c.status === "COMPLETED")
    .reduce((s, c) => s + (c.startedAt && c.endedAt ? Math.max(1, Math.ceil((c.endedAt.getTime() - c.startedAt.getTime()) / 60000)) : 1), 0);
  const cohortTalked = funnel[2].n;
  const all = view.team === "all" && teamRows.length > 1;
  const [board, booked, appDrivers, hiredDrivers] = await Promise.all([
    loadBoard(user, view.orgIds), all ? Promise.resolve([]) : scheduledCalls(user, new Date(), view.orgIds),
    sheetDrivers(view.orgIds, ["Application"], range), sheetDrivers(view.orgIds, ["Hired", "Our driver – working"], range),
  ]);
  const stuck = stuckColumns(board.columns);
  const stuckTotal = stuck.reduce((n, c) => n + c.drivers.length, 0);
  const now = Date.now();

  return (
    <>
      <div className="sec-label">Results</div>
      <div className="stats six">
        <Stat label="New leads" icon="leads" tone="blue" n={newLeads} sub={<Delta now={newLeads} prev={prevLeads} />} />
        <Stat label="Talked to Crystal" icon="voice" tone="teal" n={`${pct(cohortTalked, newLeads)}%`} sub={<>{cohortTalked} of {newLeads} new leads · <Link href={talkedHref()}>see who</Link></>} />
        <Stat label="Reached by recruiters" icon="users" tone="violet" n={`${pct(reached, sheetTotal)}%`} sub={`${reached} of ${sheetTotal} sheet leads`} />
        <Stat label="On process now" icon="check" tone="blue" n={onProcessNow} sub={<Link href="/process">open the list</Link>} />
        <DriverStat label="Application" icon="jobs" tone="amber" drivers={appDrivers} showRecruiter sub="applied in this period" />
        <DriverStat label="Hired" icon="star" tone="green" drivers={hiredDrivers} showRecruiter sub="applied in this period" />
      </div>

      <div className="sec-label">Needs a push {stuckTotal > 0 ? <span className="bad-text">· {stuckTotal} drivers</span> : <span>· nothing stuck</span>} <Link href={`/board${view.owner && view.team !== "all" ? `?team=${view.team}` : ""}`} className="sec-link">Board →</Link></div>
      <div className="section"><BoardStrip columns={stuck} showRecruiter stuck /></div>

      {all ? (
        <div className="grid two section">
          <Card title="Teams" flush>
            <table>
              <thead><tr><th>Team</th><th className="num">Leads</th><th className="num">Talked</th><th className="num">Reached</th><th className="num">App</th><th className="num">Hired</th></tr></thead>
              <tbody>
                {teamRows.map((t) => (
                  <tr key={t.id} data-href={`/dashboard?team=${t.id}`} className="clickable">
                    <td><strong>{t.name}</strong><div className="small muted">{t.sheet} sheet leads</div></td>
                    <td className="num">{t.leads}</td>
                    <td className="num">{pct(t.crystal, t.leads)}%</td>
                    <td className="num">{pct(t.reached, t.sheet)}%</td>
                    <td className="num">{t.application}</td>
                    <td className="num"><strong>{t.hired}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="Top recruiters" flush right={<Link className="small" href="/recruiters" style={{ marginRight: 16 }}>All →</Link>}>
            <RecruiterTable tabs={tabs} drivers={board.all} view={view} top />
          </Card>
        </div>
      ) : (
        <div className="section">
          <Card title="Recruiters" flush right={<Link className="small" href={`/recruiters${view.owner ? `?team=${view.team}` : ""}`} style={{ marginRight: 16 }}>Details →</Link>}>
            <RecruiterTable tabs={tabs} drivers={board.all} view={view} />
          </Card>
        </div>
      )}

      <div className="grid two section">
        <Card title="Funnel">
          {funnel.map((f, i) => <BarRow key={f.label} label={f.label} n={f.n} max={funnel[0].n} total={i ? funnel[0].n : undefined} cols="130px 1fr 80px" />)}
          <p className="small muted" style={{ margin: "10px 0 0" }}>New leads of this period and how far each got. Speed to first call: {mins(speed)} (median).</p>
        </Card>
        {view.owner ? (
          <Card title="Money" right={<Link className="small" href="/ads">Facebook ads →</Link>}>
            <div className="money-row"><span>Crystal calls (estimate)</span><strong>${(placedMins * COST_PER_MIN).toFixed(2)}</strong></div>
            <div className="money-row"><span>Billed minutes</span><span>{placedMins}</span></div>
            <div className="money-row"><span>Per driver talked to</span><span>{talkedList.length ? `$${((placedMins * COST_PER_MIN) / talkedList.length).toFixed(2)}` : "—"}</span></div>
            <div className="money-row"><span>Drivers talked to (incl. re-calls)</span><span>{talkedList.length}</span></div>
            <p className="small muted" style={{ margin: "10px 0 0" }}>~${COST_PER_MIN.toFixed(2)}/min, voicemail included; Telnyx billing has the exact spend. Facebook spend and cost per lead are on the Facebook ads page.</p>
          </Card>
        ) : (
          <Card title={`Booked calls (${booked.length})`}>
            {booked.slice(0, 8).map((t) => {
              const late = t.dueAt!.getTime() < now;
              return (
                <div className="money-row" key={t.id} data-profile={t.lead.id} style={{ cursor: "pointer" }}>
                  <span><strong>{[t.lead.firstName, t.lead.lastName].filter(Boolean).join(" ") || "(no name)"}</strong> <span className="muted small">· {t.lead.assignedTo?.name ?? "no recruiter"}</span></span>
                  <span className={late ? "bad-text" : "muted"}>{late ? "overdue" : DateTime.fromJSDate(t.dueAt!).setZone(ZONE).toFormat("ccc h:mm a")}</span>
                </div>
              );
            })}
            {!booked.length && <p className="muted">No calls booked by Crystal for your recruiters in the next 24 hours.</p>}
          </Card>
        )}
      </div>
    </>
  );
}

const tabsOf = (t: TabStats, orgId: string) => t.orgId === orgId;
const PROCESS = new Set<string>(ON_PROCESS);

/** Each recruiter's tab: leads that applied in the period, reached, and their drivers on the board now. */
function RecruiterTable({ tabs, drivers, view, top = false }: { tabs: TabStats[]; drivers: BoardDriver[]; view: TeamView; top?: boolean }) {
  const key = (orgId: string, tab: string) => `${orgId}|${tab.toLowerCase()}`;
  const onBoard = new Map<string, { process: number; stuck: number }>();
  for (const d of drivers) {
    const r = onBoard.get(key(d.orgId, d.tab)) ?? { process: 0, stuck: 0 };
    if (PROCESS.has(d.status)) r.process++;
    if (d.tone === "late") r.stuck++;
    onBoard.set(key(d.orgId, d.tab), r);
  }
  const teamName = new Map(view.orgs.map((o) => [o.id, o.name]));
  let rows = tabs.filter((t) => !/pool/i.test(t.tab));
  if (top) rows = [...rows].sort((a, b) => countOf(b, "Hired", "Our driver – working") - countOf(a, "Hired", "Our driver – working") || countOf(b, "Application") - countOf(a, "Application") || talkedBy(b) - talkedBy(a)).slice(0, 6);
  const max = Math.max(1, ...rows.map((t) => t.total));
  return (
    <table>
      <thead><tr><th>Recruiter</th><th className="num">Leads</th><th className="num">Reached</th>{!top && <th className="num">No answer</th>}{!top && <th className="num">On process</th>}<th className="num">App</th><th className="num">Hired</th>{!top && <th className="num">Stuck</th>}</tr></thead>
      <tbody>
        {rows.map((t) => {
          const who = t.recruiter ?? t.tab, b = onBoard.get(key(t.orgId, t.tab)) ?? { process: 0, stuck: 0 };
          return (
            <tr key={key(t.orgId, t.tab)}>
              <td>
                <div className="person"><div className="avatar">{initialsOf(who)}</div><div>{who}<div className="lead-bar" style={{ width: `${Math.round((t.total / max) * 100)}%` }} />{top && view.orgIds.length > 1 && <div className="small muted">{teamName.get(t.orgId)}</div>}</div></div>
              </td>
              <td className="num">{t.total}</td>
              <td className="num">{pct(talkedBy(t), t.total)}%</td>
              {!top && <td className="num">{countOf(t, "New", "No answer")}</td>}
              {!top && <td className="num">{b.process}</td>}
              <td className="num">{countOf(t, "Application")}</td>
              <td className="num"><strong>{countOf(t, "Hired", "Our driver – working")}</strong></td>
              {!top && <td className={`num${b.stuck ? " bad-text" : " muted"}`}>{b.stuck || "·"}</td>}
            </tr>
          );
        })}
        {!rows.length && <tr><td colSpan={top ? 5 : 8} className="muted">No lead sheet rows for drivers who applied in this period.</td></tr>}
      </tbody>
    </table>
  );
}
