import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { db } from "@/lib/db";
import { flash } from "@/lib/flash";
import { Card, PageHead, fmt, name } from "@/components/ui";
import { RECALL_PREFIX } from "@/lib/sheet-recall";
import { callsWithAnswers, crystalResult } from "@/lib/talked";
import { reviveResults, reviveSummary, SEGMENT_ORDER, SEGMENTS, REVIVE_CALLS, segmentOfStatus } from "@/lib/revive";
import { RETURNED, pickDayStart } from "@/lib/old-leads";

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
  const dayStart = pickDayStart(now);
  const teams = await Promise.all(orgs.filter((o) => o.campaigns.length).map(async (o) => ({
    org: o, camp: o.campaigns[0], summary: await reviveSummary(o.id, now), results: await reviveResults(o.id),
    today: await db.lead.count({ where: { orgId: o.id, reviveAt: { gte: dayStart } } }),
    recall: await recallStats(o.id, dayStart),
    recent: await db.lead.findMany({ where: { orgId: o.id, reviveAt: { not: null } }, orderBy: { reviveAt: "desc" }, take: 8, select: { id: true, firstName: true, lastName: true, reviveFrom: true, reviveTab: true, reviveAt: true, pipelineStatus: true, documentStatus: true } }),
  })));

  return (
    <>
      <PageHead
        title="Old leads"
        sub={`Drivers sitting in the lead sheets for weeks who never became drivers, sorted by why they are stuck. When a team is switched on, Crystal calls a few a day ("we've got a good offer running right now"), up to ${REVIVE_CALLS} calls each, within calling hours, after new applicants. A recruiter changing the driver's status in the sheet stops her. An old lead a recruiter sends back to the Pool is taken the same way and counts in the same daily number.`}
      />
      {!teams.length && <Card><p className="muted">No team has a campaign yet.</p></Card>}
      {teams.map(({ org, camp, summary, results, today, recent, recall }) => {
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
                {results.returned.picked > 0 && (
                  <tr>
                    <td><b>Back in the Pool</b><div className="small muted">Sent back to the Pool by a recruiter 3+ days after applying (not under 1 year of experience)</div></td>
                    <td className="num muted">·</td><td className="num muted">·</td>
                    <td className="num">{results.returned.picked}</td><td className="num">{results.returned.talked}</td><td className="num">{results.returned.interested}</td><td className="num">{results.returned.docs}</td><td className="num">{results.returned.hired}</td>
                  </tr>
                )}
              </tbody>
            </table>
            <p className="small" style={{ marginTop: 12 }}>
              <b>&quot;No answer&quot; re-calls</b> ({camp.recallMinDays > 0 ? `applied ${camp.recallMinDays}–${camp.recallMaxDays} days ago, up to ${camp.recallPerDay} a day` : "off"}): today {recall.today} · last 7 days {recall.week} ({(recall.week / 7).toFixed(1)} a day) · talked {recall.talked} · interested {recall.interested}.
              <span className="muted"> Only drivers Crystal never called before are re-called this way; everyone she already called gets the follow-up round instead.</span>
            </p>
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
                      <td className="small">{l.reviveFrom === RETURNED ? "Sent back to the Pool by a recruiter" : `${l.reviveFrom}${l.reviveTab ? ` (${l.reviveTab})` : ""} · ${SEGMENTS[segmentOfStatus(l.reviveFrom) ?? "never"].label}`}</td>
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

/** The "No answer" re-calls (sheet-recall.ts) of the last 7 days: drivers picked and how they went. */
async function recallStats(orgId: string, dayStart: Date) {
  const weekAgo = new Date(dayStart.getTime() - 6 * 86400_000);
  const recs = await db.leadSourceRecord.findMany({
    where: { sourceRecordId: { startsWith: RECALL_PREFIX }, createdAt: { gte: weekAgo }, lead: { orgId, isDemo: false } },
    select: { createdAt: true, lead: { select: { calls: { where: { status: "COMPLETED" }, select: { id: true, createdAt: true, outcome: true } } } } },
  });
  // Talked / interested by the same rule as the dashboard's "No response leads" card.
  const gave = await callsWithAnswers(recs.flatMap((r) => r.lead.calls.map((c) => c.id)));
  const got = recs.map((r) => crystalResult(r.lead.calls.filter((c) => c.createdAt >= r.createdAt), gave));
  return {
    today: recs.filter((r) => r.createdAt >= dayStart).length,
    week: recs.length,
    talked: got.filter((g) => g.talked).length,
    interested: got.filter((g) => g.interested).length,
  };
}
