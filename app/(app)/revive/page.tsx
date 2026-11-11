import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { db } from "@/lib/db";
import { flash } from "@/lib/flash";
import { Card, PageHead, fmt, name } from "@/components/ui";
import { reviveResults, reviveSummary, SEGMENT_ORDER, SEGMENTS, REVIVE_CALLS, segmentOfStatus } from "@/lib/revive";

// Old leads: drivers stuck in the lead sheets for weeks. Sorted by why they are stuck;
// Crystal calls a few a day with a "good offer running now" opener. Owner only.
const COST_PER_LEAD = 0.25; // ~2 short calls at ~$0.06/min, many unanswered

async function save(fd: FormData) {
  "use server";
  await requireOwner();
  const orgId = String(fd.get("orgId") ?? "");
  const perDay = Math.max(0, Math.min(200, Math.round(Number(fd.get("perDay") ?? 0)) || 0));
  const on = fd.get("enabled") === "on";
  const camp = await db.campaign.findFirst({ where: { orgId, isDemo: false }, orderBy: { createdAt: "asc" } });
  if (!camp) { await flash("This team has no campaign yet"); return; }
  await db.campaign.update({ where: { id: camp.id }, data: { reviveEnabled: on && perDay > 0, revivePerDay: perDay || camp.revivePerDay } });
  await flash(on && perDay > 0 ? `On: Crystal calls up to ${perDay} old leads a day for this team (within calling hours)` : "Off: no more old leads are picked for this team");
  revalidatePath("/revive");
}

export default async function Revive() {
  await requireOwner();
  const orgs = await db.organization.findMany({ orderBy: [{ isMain: "desc" }, { createdAt: "asc" }], include: { campaigns: { where: { isDemo: false }, orderBy: { createdAt: "asc" }, take: 1 } } });
  const now = new Date();
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const teams = await Promise.all(orgs.filter((o) => o.campaigns.length).map(async (o) => ({
    org: o, camp: o.campaigns[0], summary: await reviveSummary(o.id, now), results: await reviveResults(o.id),
    today: await db.lead.count({ where: { orgId: o.id, reviveAt: { gte: dayStart } } }),
    recent: await db.lead.findMany({ where: { orgId: o.id, reviveAt: { not: null } }, orderBy: { reviveAt: "desc" }, take: 8, select: { id: true, firstName: true, lastName: true, reviveFrom: true, reviveTab: true, reviveAt: true, pipelineStatus: true, documentStatus: true } }),
  })));

  return (
    <>
      <PageHead
        title="Old leads"
        sub={`Drivers sitting in the lead sheets for weeks who never became drivers, sorted by why they are stuck. When a team is switched on, Crystal calls a few a day ("we've got a good offer running right now"), up to ${REVIVE_CALLS} calls each, within calling hours, after new applicants. A recruiter changing the driver's status in the sheet stops her.`}
      />
      {!teams.length && <Card><p className="muted">No team has a campaign yet.</p></Card>}
      {teams.map(({ org, camp, summary, results, today, recent }) => {
        const ready = SEGMENT_ORDER.reduce((n, s) => n + summary.segments[s].ready, 0);
        return (
          <Card key={org.id} title={org.name} right={<span className="small muted">{summary.total} drivers in the sheet{camp.reviveEnabled ? ` · on, ${today} of ${camp.revivePerDay} picked today` : " · off"}</span>}>
            <div className="stats four">
              <div className="stat"><div className="l">Ready to call</div><div className="n">{ready}</div><div className="d">{camp.revivePerDay ? `~${Math.ceil(ready / Math.max(1, camp.revivePerDay))} days at ${camp.revivePerDay}/day` : ""}</div></div>
              <div className="stat"><div className="l">Picked so far</div><div className="n">{results.all.picked}</div><div className="d">{results.all.talked} talked to Crystal</div></div>
              <div className="stat"><div className="l">Interested</div><div className="n">{results.all.interested}</div><div className="d">{results.all.docs} sent CDL · {results.all.hired} hired</div></div>
              <div className="stat"><div className="l">Cost (estimate)</div><div className="n">${(results.all.picked * COST_PER_LEAD).toFixed(2)}</div><div className="d">~${COST_PER_LEAD.toFixed(2)} per old lead</div></div>
            </div>
            <table>
              <thead><tr><th>Why stuck</th><th className="num">Ready</th><th className="num">Not yet (too recent)</th><th className="num">Picked</th><th className="num">Talked</th><th className="num">Interested</th><th className="num">CDL</th><th className="num">Hired</th></tr></thead>
              <tbody>
                {SEGMENT_ORDER.map((s) => {
                  const r = results.bySegment[s];
                  return (
                    <tr key={s}>
                      <td><b>{SEGMENTS[s].label}</b><div className="small muted">{SEGMENTS[s].hint}</div></td>
                      <td className="num">{summary.segments[s].ready}</td><td className="num">{summary.segments[s].later}</td>
                      <td className="num">{r.picked}</td><td className="num">{r.talked}</td><td className="num">{r.interested}</td><td className="num">{r.docs}</td><td className="num">{r.hired}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {summary.skipped.length > 0 && (
              <p className="small muted">Left alone: {summary.skipped.map((x) => `${x.reason} ${x.n}`).join(" · ")}</p>
            )}
            <form action={save} className="inline" style={{ marginTop: 12 }}>
              <input type="hidden" name="orgId" value={org.id} />
              <label className="inline" style={{ gap: 6 }}><input type="checkbox" name="enabled" defaultChecked={camp.reviveEnabled} /> Crystal calls old leads</label>
              <span className="small">at most</span>
              <input type="number" name="perDay" defaultValue={camp.revivePerDay} min={0} max={200} style={{ width: 80 }} />
              <span className="small">a day (~${(camp.revivePerDay * COST_PER_LEAD).toFixed(2)}/day)</span>
              <button className="secondary">Save</button>
            </form>
            {recent.length > 0 && (
              <table style={{ marginTop: 12 }}>
                <thead><tr><th>Recently picked</th><th>Was</th><th>Picked</th><th>Now</th></tr></thead>
                <tbody>
                  {recent.map((l) => (
                    <tr key={l.id} data-href={`/leads/${l.id}`}>
                      <td><Link href={`/leads/${l.id}`}>{name(l)}</Link></td>
                      <td className="small">{l.reviveFrom}{l.reviveTab ? ` (${l.reviveTab})` : ""} · {SEGMENTS[segmentOfStatus(l.reviveFrom) ?? "never"].label}</td>
                      <td className="small">{fmt(l.reviveAt)}</td>
                      <td className="small">{l.pipelineStatus.toLowerCase().replace(/_/g, " ")}{l.documentStatus === "RECEIVED" ? " · CDL in" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        );
      })}
    </>
  );
}
