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
import { appliedIn, firstSource, isNewApplicant } from "@/lib/new-leads";
import { RETURNED } from "@/lib/old-leads";
import { LEAD_SEL, leadRow, sheetRowItems } from "@/lib/dashboard-lists";
import { ListStat } from "@/components/list-stat";
import { callsWithAnswers, isTalk, talkedDrivers, teamsScope } from "@/lib/talked";
import { countOf, orderStatuses, tabStats, talkedBy, type TabStats } from "@/lib/sheet-rows";
import { ON_PROCESS } from "@/lib/on-process";
import { statusTone } from "@/lib/recruiter-status";
import { ZONE, pct, type Period, type TeamView } from "@/lib/dashboard-view";
import { Card, initialsOf } from "@/components/ui";
import { BoardStrip, DriverStat } from "@/components/board-strip";
import { loadBoard, pushColumns, sheetDrivers, type BoardDriver } from "@/lib/board";
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
const sum = (tabs: TabStats[], f: (t: TabStats) => number) => tabs.reduce((n, t) => n + f(t), 0);

export async function ManagerDashboard({ user, view, p }: { user: Pick<User, "id" | "role" | "orgId">; view: TeamView; p: Period }) {
  const scope = teamsScope(view.orgIds, config.mode === "demo");
  const { range, prev } = p;
  const calls = { lead: scope, provider: { not: UPLOAD_PROVIDER } };
  const distinctLeads = (where: Prisma.CallAttemptWhereInput) => db.callAttempt.findMany({ where, distinct: ["leadId"], select: { leadId: true } }).then((x) => x.length);

  // New leads = new applicants only, by the day they applied. Crystal's "No answer" re-calls and
  // old leads (her own picks and the ones recruiters send back to the Pool) also create leads;
  // they have their own cards (new-leads.ts). Referrals are a recruiter's to call.
  const [prevLeads, rangeAll, chartCalls, calledDrivers, talkedList, tabs, recallRecs, revivedLeads, sheetRows, allTabs] = await Promise.all([
    db.lead.findMany({ where: { AND: [scope, appliedIn(prev)] }, select: firstSource }).then((x) => x.filter(isNewApplicant).length),
    db.lead.findMany({ where: { AND: [scope, appliedIn(range)] }, orderBy: { createdAt: "desc" }, select: { ...firstSource, ...LEAD_SEL, pipelineStatus: true, documentStatus: true, hireStage: true } }),
    db.callAttempt.findMany({ where: { ...calls, status: PLACED, createdAt: range }, select: { id: true, createdAt: true, status: true, outcome: true, startedAt: true, endedAt: true } }),
    distinctLeads({ ...calls, status: PLACED, createdAt: range }),
    talkedDrivers(scope, range),
    tabStats(view.orgIds, range),
    db.leadSourceRecord.findMany({ where: { sourceRecordId: { startsWith: RECALL_PREFIX }, createdAt: range, lead: scope }, orderBy: { createdAt: "desc" }, select: { createdAt: true, lead: { select: LEAD_SEL } } }),
    db.lead.findMany({ where: { ...scope, reviveAt: range }, orderBy: { reviveAt: "desc" }, select: { ...LEAD_SEL, reviveAt: true, reviveFrom: true, appliedAt: true } }),
    db.sheetRow.findMany({ where: { orgId: { in: view.orgIds }, appliedAt: range }, orderBy: { appliedAt: "desc" }, select: { id: true, orgId: true, phoneE164: true, tab: true, status: true, name: true } }),
    tabStats(view.orgIds),
  ]);
  const rangeLeads = rangeAll.filter(isNewApplicant);
  const newLeads = rangeLeads.length;
  const gave = await callsWithAnswers([...chartCalls, ...rangeAll.flatMap((l) => l.calls), ...recallRecs.flatMap((r) => r.lead.calls), ...revivedLeads.flatMap((l) => l.calls)].map((c) => c.id));
  const talked = (c: { id: string; status?: string; outcome: string | null }) => isTalk(c, gave);

  // The lists behind the cards.
  const several = view.orgIds.length > 1;
  const teamOf = (orgId: string) => several ? view.orgs.find((o) => o.id === orgId)?.name ?? null : null;
  // Who works each driver: the recruiter whose sheet tab has them (Pool if nobody yet).
  const tabOwner = new Map(allTabs.map((t) => [`${t.orgId}|${t.tab.toLowerCase()}`, t.recruiter]));
  const recruiterOf = (orgId: string, tab: string) => tabOwner.get(`${orgId}|${tab.toLowerCase()}`) ?? (/pool/i.test(tab) ? "Pool" : tab);
  const listPhones = [...new Set([...rangeLeads, ...recallRecs.map((r) => r.lead), ...revivedLeads].map((l) => l.phoneE164))];
  const [sheetLeads, listSheet] = await Promise.all([
    db.lead.findMany({ where: { ...scope, phoneE164: { in: [...new Set(sheetRows.map((r) => r.phoneE164))] } }, select: { id: true, orgId: true, phoneE164: true, firstName: true, lastName: true } }),
    db.sheetRow.findMany({ where: { orgId: { in: view.orgIds }, phoneE164: { in: listPhones } }, select: { orgId: true, phoneE164: true, tab: true, status: true } }),
  ]);
  const sheetOf = new Map(listSheet.map((r) => [`${r.orgId}|${r.phoneE164}`, { recruiter: recruiterOf(r.orgId, r.tab), status: r.status }]));
  const onSheet = (l: { orgId: string; phoneE164: string }) => sheetOf.get(`${l.orgId}|${l.phoneE164}`);
  const newRows = rangeLeads.map((l) => leadRow(l, gave, teamOf(l.orgId), { sheet: onSheet(l) }));
  const recallRows = recallRecs.map((r) => leadRow(r.lead, gave, teamOf(r.lead.orgId), { since: r.createdAt, sheet: onSheet(r.lead) }));
  // An old lead is one Crystal picked from a recruiter's tab ("was No answer") or one a recruiter sent back to the Pool.
  const returnedNote = (l: { appliedAt: Date | null }) => `back in the Pool${l.appliedAt ? `, applied ${DateTime.fromJSDate(l.appliedAt).setZone(ZONE).toFormat("LLL d")}` : ""}`;
  const oldRows = revivedLeads.map((l) => leadRow(l, gave, teamOf(l.orgId), { since: l.reviveAt ?? undefined, sheet: onSheet(l), ...(l.reviveFrom === RETURNED ? { note: returnedNote(l) } : { was: l.reviveFrom ?? undefined }) }));
  const returnedCount = revivedLeads.filter((l) => l.reviveFrom === RETURNED).length;
  const sheetRowsOut = sheetRowItems(sheetRows, sheetLeads, recruiterOf, teamOf);
  // "No response" and "Old leads" windows: everyone Crystal picked in the period, and how it went.
  const picked = (rows: ReturnType<typeof leadRow>[]) => [
    { key: "all", label: "All picked", items: rows.map((r) => r.item) },
    { key: "talked", label: "Talked to Crystal", items: rows.filter((r) => r.talked).map((r) => r.item) },
    { key: "interested", label: "Interested", items: rows.filter((r) => r.interested).map((r) => r.item) },
    { key: "no", label: "Didn't talk", items: rows.filter((r) => !r.talked).map((r) => r.item) },
  ];
  const pickedRates = (rows: ReturnType<typeof leadRow>[]) => {
    const t = rows.filter((r) => r.talked).length, i = rows.filter((r) => r.interested).length;
    return [
      { label: "Talked to Crystal", value: `${pct(t, rows.length)}%`, sub: `${t} of ${rows.length} picked`, group: "talked" },
      { label: "Interested", value: `${pct(i, t)}%`, sub: `${i} of ${t} who talked`, group: "interested" },
    ];
  };
  const pickedSub = (rows: ReturnType<typeof leadRow>[]) => `${rows.filter((r) => r.talked).length} talked · ${rows.filter((r) => r.interested).length} interested`;

  const reached = sum(tabs, talkedBy), sheetTotal = sum(tabs, (t) => t.total);
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
    };
  }) : [];

  const placedMins = chartCalls.filter((c) => c.createdAt >= p.since && c.createdAt < p.until && c.status === "COMPLETED")
    .reduce((s, c) => s + (c.startedAt && c.endedAt ? Math.max(1, Math.ceil((c.endedAt.getTime() - c.startedAt.getTime()) / 60000)) : 1), 0);
  const cohortTalked = funnel[2].n;
  const all = view.team === "all" && teamRows.length > 1;
  // Every number follows the dates picked: the board part is the drivers who applied in them.
  const [board, booked, appDrivers, hiredDrivers] = await Promise.all([
    loadBoard(user, view.orgIds, undefined, new Date(), range), all ? Promise.resolve([]) : scheduledCalls(user, new Date(), view.orgIds),
    sheetDrivers(view.orgIds, ["Application"], range), sheetDrivers(view.orgIds, ["Hired", "Our driver – working"], range),
  ]);
  const push = pushColumns(board.columns);
  const stuckTotal = push.reduce((n, c) => n + c.late, 0);
  const now = Date.now();

  return (
    <>
      <div className="sec-label">Results</div>
      <div className="stats six">
        <ListStat label="New leads" icon="leads" tone="blue" n={newLeads} sub={<Delta now={newLeads} prev={prevLeads} />}
          rates={[
            { label: "Talked to Crystal", value: `${pct(cohortTalked, newLeads)}%`, sub: `${cohortTalked} of ${newLeads} new leads`, group: "talked" },
            { label: "Reached by recruiters", value: `${pct(reached, sheetTotal)}%`, sub: `${reached} of ${sheetTotal} sheet leads`, group: "reached" },
          ]}
          groups={[
            { key: "all", label: "All new leads", items: newRows.map((r) => r.item) },
            { key: "talked", label: "Talked to Crystal", items: newRows.filter((r) => r.talked).map((r) => r.item) },
            { key: "not", label: "Didn't talk", items: newRows.filter((r) => !r.talked).map((r) => r.item) },
            { key: "reached", label: "Reached by recruiters", items: sheetRowsOut.filter((r) => r.reached).map((r) => r.item) },
            { key: "unreached", label: "Not reached", items: sheetRowsOut.filter((r) => !r.reached).map((r) => r.item) },
          ]} />
        <ListStat label="No response leads" icon="voice" tone="teal" n={recallRows.length} sub={pickedSub(recallRows)} rates={pickedRates(recallRows)} groups={picked(recallRows)} />
        <ListStat label="Old leads" icon="users" tone="violet" n={oldRows.length} sub={pickedSub(oldRows)} rates={pickedRates(oldRows)}
          groups={[...picked(oldRows), ...(returnedCount ? [{ key: "returned", label: "Back in the Pool", items: oldRows.filter((_, i) => revivedLeads[i].reviveFrom === RETURNED).map((r) => r.item) }] : [])]} />
        <DriverStat label="On process" icon="check" tone="blue" drivers={board.all.filter((d) => PROCESS.has(d.status))} showRecruiter sub="applied in this period" />
        <DriverStat label="Application" icon="jobs" tone="amber" drivers={appDrivers} showRecruiter sub="applied in this period" />
        <DriverStat label="Hired" icon="star" tone="green" drivers={hiredDrivers} showRecruiter sub="applied in this period" />
      </div>

      <div className="sec-label">Needs a push <span className="muted">· drivers who applied in this period, by status now</span> {stuckTotal > 0 ? <span className="bad-text">· {stuckTotal} stuck</span> : <span>· nothing stuck</span>} <Link href={`/board${view.owner && view.team !== "all" ? `?team=${view.team}` : ""}`} className="sec-link">Board →</Link></div>
      <div className="section"><BoardStrip columns={push} showRecruiter /></div>

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
