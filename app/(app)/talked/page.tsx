import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { config } from "@/lib/config";
import { Card, PageHead, fmt, initialsOf } from "@/components/ui";
import { LeadPopup } from "@/components/lead-popup";
import { statusTone } from "@/lib/recruiter-status";
import { dashboardScope, groupCounts, talkedDrivers } from "@/lib/talked";

const day = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" });

/** The drivers behind the dashboard's "Drivers talked to", with where each one is now. */
export default async function Talked({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const until = sp.until && !isNaN(Date.parse(sp.until)) ? new Date(sp.until) : new Date();
  const since = sp.since && !isNaN(Date.parse(sp.since)) ? new Date(sp.since) : new Date(until.getTime() - 7 * 86400_000);
  const mine = (sp.who ?? (user.role === "ADMIN" ? "all" : "mine")) === "mine";
  const all = await talkedDrivers(dashboardScope(user, mine, config.mode === "demo"), { gte: since, lt: until });
  const groups = groupCounts(all);
  const rows = sp.group ? all.filter((d) => d.group === sp.group) : all;
  const href = (group?: string) => `/talked?${new URLSearchParams({ since: since.toISOString(), until: until.toISOString(), who: mine ? "mine" : "all", ...(group ? { group } : {}) })}`;
  return (
    <>
      <PageHead
        title="Drivers Crystal talked to"
        sub={`${all.length} drivers, ${day(since)} – ${day(new Date(until.getTime() - 1))} (Central time)${mine ? ", your leads" : ""}. A real talk: the driver answered at least one question or gave a clear yes, no or call back. Status: the recruiter's, else what the driver told Crystal.`}
        right={<Link className="btn secondary" href="/dashboard">Back to dashboard</Link>}
      />
      <div className="tabs">
        <Link href={href()} className={`tab ${!sp.group ? "on" : ""}`}>All<span className="c">{all.length}</span></Link>
        {groups.map((g) => <Link key={g.label} href={href(g.label)} className={`tab ${sp.group === g.label ? "on" : ""}`}>{g.label}<span className="c">{g.n}</span></Link>)}
      </div>
      <Card flush>
        <table>
          <thead><tr><th>Driver</th><th>Phone</th><th>Status now</th><th>Told Crystal</th><th>Recruiter</th><th>Last talk</th></tr></thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.leadId} data-profile={d.leadId} className="clickable">
                <td><div className="person"><div className="avatar">{initialsOf(d.name)}</div><Link href={`/leads/${d.leadId}`} data-profile={d.leadId}>{d.name}</Link></div></td>
                <td className="small">{d.phone}</td>
                <td>{d.recruiterStatus ? <span className={`badge ${statusTone(d.recruiterStatus)}`}>{d.recruiterStatus}</span> : <span className="muted small">no recruiter status</span>}</td>
                <td className="small">{d.crystal}</td>
                <td className="small">{d.recruiter ?? <span className="muted">unassigned</span>}</td>
                <td className="small">{fmt(d.lastTalk)}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={6} className="muted">No drivers.</td></tr>}
          </tbody>
        </table>
      </Card>
      <LeadPopup />
    </>
  );
}
