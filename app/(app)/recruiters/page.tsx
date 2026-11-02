import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { config } from "@/lib/config";
import { keepQuery, pct, period, teamView } from "@/lib/dashboard-view";
import { countOf, tabStats, talkedBy, type TabStats } from "@/lib/sheet-rows";
import { talkedDrivers, teamsScope } from "@/lib/talked";
import { scheduledByRecruiter } from "@/lib/scheduled-calls";
import { loadOnProcess } from "@/lib/on-process";
import { DateRangePicker } from "@/components/date-range-picker";
import { Card, PageHead, initialsOf } from "@/components/ui";

/**
 * Every recruiter's numbers side by side for a manager: how many drivers they got, how
 * many they reached (their lead sheet tab), what Crystal did with their leads, who is on
 * process, applications, hires and booked calls still open.
 */
export default async function Recruiters({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireAdmin();
  const sp = await searchParams;
  const p = period(sp);
  const view = await teamView(user, sp.team);
  const scope = teamsScope(view.orgIds, config.mode === "demo");
  const [users, tabs, leads, talked, booked, process] = await Promise.all([
    db.user.findMany({ where: { orgId: { in: view.orgIds }, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, role: true, orgId: true } }),
    tabStats(view.orgIds, p.range),
    db.lead.groupBy({ by: ["assignedToId"], where: { ...scope, createdAt: p.range }, _count: true }),
    talkedDrivers(scope, p.range),
    scheduledByRecruiter(view.orgIds),
    Promise.all(view.orgIds.map((orgId) => loadOnProcess({ id: user.id, role: "ADMIN", orgId }))).then((x) => x.flat()),
  ]);
  const teamName = new Map(view.orgs.map((o) => [o.id, o.name]));
  const rows = users.map((u) => {
    const t: TabStats[] = tabs.filter((x) => x.recruiterId === u.id);
    const sum = (f: (x: TabStats) => number) => t.reduce((n, x) => n + f(x), 0);
    const sheet = sum((x) => x.total), reached = sum(talkedBy);
    return {
      ...u, tab: t.map((x) => x.tab).join(", "), sheet, reached,
      noAnswer: sum((x) => countOf(x, "No answer", "New")),
      notInterested: sum((x) => countOf(x, "Not interested", "Not qualified", "Declined", "SAP", "Changed his mind")),
      application: sum((x) => countOf(x, "Application")), hired: sum((x) => countOf(x, "Hired", "Our driver – working")),
      leads: leads.find((l) => l.assignedToId === u.id)?._count ?? 0,
      crystal: talked.filter((d) => d.recruiter === u.name).length,
      onProcess: process.filter((d) => d.recruiterId === u.id).length,
      booked: booked.get(u.id) ?? { open: 0, late: 0 },
    };
  }).filter((r) => r.role === "RECRUITER" || r.sheet || r.leads)
    .sort((a, b) => b.hired - a.hired || b.application - a.application || b.reached - a.reached || b.sheet - a.sheet);
  const unowned = tabs.filter((t) => !t.recruiterId);
  const several = view.orgIds.length > 1;

  const tools = (
    <div className="dash-tools">
      {view.owner && view.orgs.length > 1 && (
        <div className="tabs" style={{ margin: 0 }}>
          <Link href={keepQuery("/recruiters", sp, "team", "all")} className={`tab ${view.team === "all" ? "on" : ""}`}>All teams</Link>
          {view.orgs.map((o) => <Link key={o.id} href={keepQuery("/recruiters", sp, "team", o.id)} className={`tab ${view.team === o.id ? "on" : ""}`}>{o.name}</Link>)}
        </div>
      )}
      <DateRangePicker from={p.from.toISODate()!} to={p.to.toISODate()!} today={p.now.toISODate()!} label={p.label} />
    </div>
  );

  return (
    <>
      <PageHead title="Recruiters" sub={`${view.teamName} · drivers who applied ${p.text} (Central time)`} right={tools} />
      <Card flush>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Recruiter</th>{several && <th>Team</th>}
                <th className="num" title="Drivers in their lead sheet tab who applied in this period">Sheet leads</th>
                <th className="num" title="Status beyond New, No answer and Not in service">Reached</th>
                <th className="num">New / No answer</th>
                <th className="num">Not interested / not qualified</th>
                <th className="num" title="Crystal's leads assigned to them in this period">Crystal leads</th>
                <th className="num">Talked to Crystal</th>
                <th className="num">On process now</th>
                <th className="num">Application</th>
                <th className="num">Hired</th>
                <th className="num" title="Calls Crystal booked for them, not yet marked made">Booked calls</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} {...(r.orgId === user.orgId ? { "data-href": `/leads?assigned=${r.id}`, className: "clickable" } : {})}>
                  <td><div className="person"><div className="avatar">{initialsOf(r.name)}</div><div><strong>{r.name}</strong><div className="small muted">{r.tab ? `${r.tab} tab` : "no sheet tab found"}</div></div></div></td>
                  {several && <td className="small">{teamName.get(r.orgId)}</td>}
                  <td className="num"><strong>{r.sheet}</strong></td>
                  <td className="num">{r.reached} <span className="muted">{pct(r.reached, r.sheet)}%</span></td>
                  <td className="num">{r.noAnswer}</td>
                  <td className="num">{r.notInterested}</td>
                  <td className="num">{r.leads}</td>
                  <td className="num">{r.crystal}</td>
                  <td className="num">{r.onProcess}</td>
                  <td className="num">{r.application}</td>
                  <td className="num"><strong>{r.hired}</strong></td>
                  <td className="num">{r.booked.open}{r.booked.late > 0 && <div className="small bad-text">{r.booked.late} overdue</div>}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={several ? 12 : 11} className="muted">No recruiters yet. Add them on the Users page.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ margin: "8px 14px 12px" }}>
          Sheet columns are the recruiter&apos;s own tab in the lead sheet (read every 15 minutes), counting drivers who applied in this period by their status now. Click a recruiter of your team for their leads.
          {unowned.length > 0 && <> Tabs without a recruiter login: {unowned.map((t) => `${t.tab} (${t.total})`).join(", ")}.</>}
        </p>
      </Card>
    </>
  );
}
