import { revalidatePath } from "next/cache";
import Link from "next/link";
import { DateTime } from "luxon";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { leadScope } from "@/lib/rbac";
import { config } from "@/lib/config";
import { sourceLabel } from "@/lib/driver-profile";
import { Card, Stat, Badge, PageHead, fmt, name, initials, initialsOf } from "@/components/ui";
import { loadDemoLeads } from "@/lib/demo-actions";
import { drainQueue } from "@/lib/jobs/queue";
import { handlers } from "@/lib/jobs/handlers";
import { flash } from "@/lib/flash";

// Day buckets and "today" follow US Central time.
const ZONE = "America/Chicago";
// Rough AI call cost per started minute (Telnyx line + agent), shown as an estimate.
const COST_PER_MIN = 0.06;
const RANGES = { today: "Today", "7d": "Last 7 days", "30d": "Last 30 days" } as const;
type Range = keyof typeof RANGES;
const ANSWERED = ["COMPLETED"] as const;
// A real conversation is a call where the driver gave Crystal at least one screening
// answer (English rating alone does not count), or made a clear decision. Voicemail,
// iPhone call screening and quick hang-ups are "completed" calls too, so length alone
// does not count.
const TEST_LAST_NAMES = ["(owner test)", "Test", "test", "TEST"];
const OWNER_PHONES = ["+18162913808", "+18158461661"];
const DECIDED = ["INTERESTED", "NOT_INTERESTED", "CALLBACK", "HUMAN_REQUESTED"];
type CallRow = { id: string; status?: string; outcome: string | null };
/** Ids of the calls in which the driver answered a screening question. */
async function callsWithAnswers(ids: string[]) {
  const rows = await db.screeningField.findMany({ where: { callAttemptId: { in: ids }, key: { not: "english_level" }, reportedValue: { not: null } }, select: { callAttemptId: true }, distinct: ["callAttemptId"] });
  return new Set(rows.map((r) => r.callAttemptId!));
}
const PLACED = { notIn: ["CANCELED", "SCHEDULED"] as ("CANCELED" | "SCHEDULED")[] };

async function loadDemo() {
  "use server";
  const u = await requireUser();
  if (u.role !== "ADMIN") throw new Error("Admin only");
  await loadDemoLeads(u.orgId, u.id);
  await flash("Demo leads loaded");
  revalidatePath("/dashboard");
}

async function processNow() {
  "use server";
  const u = await requireUser();
  if (u.role !== "ADMIN" || config.mode !== "demo") throw new Error("Demo admin only");
  await drainQueue(handlers, "dashboard");
  await flash("Due jobs processed");
  revalidatePath("/dashboard");
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mins = (m: number | null) => (m === null ? "—" : m < 1 ? "<1 min" : m < 60 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`);

function Delta({ now, prev, invert }: { now: number; prev: number; invert?: boolean }) {
  if (!prev && !now) return <span>no change</span>;
  if (!prev) return <span className={invert ? "delta-down" : "delta-up"}>new</span>;
  const d = Math.round(((now - prev) / prev) * 100);
  if (d === 0) return <span>same as before</span>;
  const good = invert ? d < 0 : d > 0;
  return <span><span className={good ? "delta-up" : "delta-down"}>{d > 0 ? "▲" : "▼"} {Math.abs(d)}%</span> vs previous</span>;
}

function CallsChart({ days }: { days: { label: string; answered: number; other: number }[] }) {
  const W = 720, H = 220, L = 30, R = 18, B = 24, T = 10;
  const max = Math.max(4, ...days.map((d) => d.answered + d.other));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const slot = (W - L - R) / days.length;
  const bw = Math.max(4, Math.min(28, slot - 6));
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Calls per day, talked and not">
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line className="grid-line" x1={L} x2={W - R} y1={y(i * step)} y2={y(i * step)} />
            <text className="axis" x={L - 6} y={y(i * step) + 4} textAnchor="end">{i * step}</text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = L + i * slot + (slot - bw) / 2;
          const ya = y(d.answered), yo = y(d.answered + d.other);
          const showLabel = days.length <= 14 || i % 3 === 0 || i === days.length - 1;
          return (
            <g key={i}>
              <title>{`${d.label}: ${d.answered + d.other} calls, ${d.answered} talked to a driver`}</title>
              <rect x={L + i * slot} y={T} width={slot} height={H - T - B} fill="transparent" />
              {d.other > 0 && <rect x={x} y={yo} width={bw} height={Math.max(0, ya - yo - (d.answered ? 2 : 0))} rx={3} fill="var(--series-muted)" />}
              {d.answered > 0 && <rect x={x} y={ya} width={bw} height={y(0) - ya} rx={3} fill="var(--series-1)" />}
              {showLabel && <text className="axis" x={x + bw / 2} y={H - 6} textAnchor="middle">{d.label}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default async function Dashboard({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const range: Range = sp.range && sp.range in RANGES ? (sp.range as Range) : "7d";
  const isDemo = config.mode === "demo";
  // Owner test calls (scripts/telnyx-test-call.ts, "Remzi Test" sheet rows) are not real results.
  const scope = { ...leadScope(user), isDemo, phoneE164: { notIn: OWNER_PHONES }, OR: [{ lastName: null }, { lastName: { notIn: TEST_LAST_NAMES } }] };
  const now = DateTime.now().setZone(ZONE);
  const start = range === "today" ? now.startOf("day") : now.startOf("day").minus({ days: range === "7d" ? 6 : 29 });
  const len = now.toMillis() - start.toMillis();
  const since = start.toJSDate();
  const prevSince = new Date(since.getTime() - len);
  const inRange = { gte: since };
  const inPrev = { gte: prevSince, lt: since };
  const chartDays = range === "30d" ? 30 : 14;
  const chartStart = now.startOf("day").minus({ days: chartDays - 1 });

  const [
    newLeads, prevLeads, placed, prevPlaced, answeredCalls, prevAnsweredCalls, interestedLeads, prevInterested,
    docsLeads, prevDocs, chartCalls, outcomes, rangeLeads, bySource, attention, openTasks, recent, pendingJobs, hiredNow, hiredPrev,
  ] = await Promise.all([
    db.lead.count({ where: { ...scope, createdAt: inRange } }),
    db.lead.count({ where: { ...scope, createdAt: inPrev } }),
    db.callAttempt.count({ where: { lead: scope, status: PLACED, createdAt: inRange } }),
    db.callAttempt.count({ where: { lead: scope, status: PLACED, createdAt: inPrev } }),
    db.callAttempt.findMany({ where: { lead: scope, status: { in: [...ANSWERED] }, createdAt: inRange }, select: { id: true, outcome: true, startedAt: true, endedAt: true } }),
    db.callAttempt.findMany({ where: { lead: scope, status: { in: [...ANSWERED] }, createdAt: inPrev }, select: { id: true, outcome: true } }),
    db.callAttempt.findMany({ where: { lead: scope, outcome: "INTERESTED", createdAt: inRange }, distinct: ["leadId"], select: { leadId: true } }).then((x) => x.length),
    db.callAttempt.findMany({ where: { lead: scope, outcome: "INTERESTED", createdAt: inPrev }, distinct: ["leadId"], select: { leadId: true } }).then((x) => x.length),
    db.document.findMany({ where: { lead: scope, uploadedAt: inRange }, distinct: ["leadId"], select: { leadId: true } }).then((x) => x.length),
    db.document.findMany({ where: { lead: scope, uploadedAt: inPrev }, distinct: ["leadId"], select: { leadId: true } }).then((x) => x.length),
    db.callAttempt.findMany({ where: { lead: scope, status: PLACED, createdAt: { gte: chartStart.toJSDate() } }, select: { id: true, createdAt: true, status: true, outcome: true } }),
    db.callAttempt.groupBy({ by: ["outcome"], where: { lead: scope, status: PLACED, createdAt: inRange }, _count: true }),
    db.lead.findMany({
      where: { ...scope, createdAt: inRange },
      select: { createdAt: true, pipelineStatus: true, documentStatus: true, hireStage: true, assignedTo: { select: { id: true, name: true } }, calls: { where: { status: PLACED }, orderBy: { createdAt: "asc" }, select: { id: true, createdAt: true, status: true, outcome: true } } },
    }),
    db.leadSourceRecord.groupBy({ by: ["sourceSystem"], where: { lead: { ...scope, createdAt: inRange } }, _count: true }),
    db.lead.findMany({
      where: { ...scope, OR: [{ pipelineStatus: { in: ["NEEDS_TIMEZONE", "NEEDS_PERMISSION", "HANDOFF_READY", "CALLBACK_SCHEDULED"] } }, { calls: { some: { outcome: "HUMAN_REQUESTED", createdAt: inRange } } }] },
      orderBy: { updatedAt: "desc" }, take: 8,
    }),
    db.task.count({ where: { status: "OPEN", lead: scope, ...(user.role === "ADMIN" ? {} : { assignedToId: user.id }) } }),
    db.activityEvent.findMany({ where: { lead: scope }, orderBy: { createdAt: "desc" }, take: 12, include: { lead: true } }),
    db.job.count({ where: { status: "PENDING", runAt: { lte: new Date() } } }),
    db.lead.count({ where: { ...scope, hireStage: "HIRED", hiredAt: inRange } }),
    db.lead.count({ where: { ...scope, hireStage: "HIRED", hiredAt: inPrev } }),
  ]);

  const gaveAnswers = await callsWithAnswers([...answeredCalls, ...prevAnsweredCalls, ...chartCalls, ...rangeLeads.flatMap((l) => l.calls)].map((c) => c.id));
  const talked = (c: CallRow) => (c.status ?? "COMPLETED") === "COMPLETED" && (DECIDED.includes(c.outcome ?? "") || gaveAnswers.has(c.id));
  const prevAnswered = prevAnsweredCalls.filter(talked).length;
  const pickedUp = answeredCalls.length;
  const answered = answeredCalls.filter(talked).length;
  const talkMins = answeredCalls.map((c) => (c.startedAt && c.endedAt ? Math.max(0, (c.endedAt.getTime() - c.startedAt.getTime()) / 60000) : 0));
  const billedMins = talkMins.reduce((s, m) => s + Math.max(1, Math.ceil(m)), 0);
  const cost = billedMins * COST_PER_MIN;
  const avgTalk = talkMins.length ? talkMins.reduce((a, b) => a + b, 0) / talkMins.length : 0;
  const speeds = rangeLeads.filter((l) => l.calls[0]).map((l) => (l.calls[0].createdAt.getTime() - l.createdAt.getTime()) / 60000);
  const speed = median(speeds);
  const calledLeads = rangeLeads.filter((l) => l.calls[0]).length;

  const days = Array.from({ length: chartDays }, (_, i) => {
    const d = chartStart.plus({ days: i });
    return { key: d.toISODate()!, label: d.toFormat("MMM d"), answered: 0, other: 0 };
  });
  for (const c of chartCalls) {
    const day = days.find((d) => d.key === DateTime.fromJSDate(c.createdAt).setZone(ZONE).toISODate());
    if (day) (talked(c) ? day.answered++ : day.other++);
  }

  // Funnel follows the leads that came in during the period, wherever they are now.
  const INTERESTED_UP = ["INTERESTED", "DOCS_REQUESTED", "DOCS_RECEIVED", "HANDOFF_READY", "HANDED_OFF"];
  const funnel = [
    { label: "New leads", n: newLeads },
    { label: "Called", n: calledLeads },
    { label: "Talked to driver", n: rangeLeads.filter((l) => l.calls.some(talked)).length },
    { label: "Interested", n: rangeLeads.filter((l) => INTERESTED_UP.includes(l.pipelineStatus)).length },
    { label: "CDL received", n: rangeLeads.filter((l) => l.documentStatus === "RECEIVED").length },
    { label: "Handed off", n: rangeLeads.filter((l) => ["HANDOFF_READY", "HANDED_OFF"].includes(l.pipelineStatus)).length },
    { label: "Orientation", n: rangeLeads.filter((l) => ["ORIENTATION", "HIRED"].includes(l.hireStage)).length },
    { label: "Hired", n: rangeLeads.filter((l) => l.hireStage === "HIRED").length },
  ];
  const cohortHired = rangeLeads.filter((l) => l.hireStage === "HIRED").length;
  const fMax = Math.max(1, ...funnel.map((f) => f.n));

  const outcomeRows = outcomes
    .map((o) => ({ label: (o.outcome ?? "IN_PROGRESS").replace(/_/g, " ").toLowerCase(), n: o._count }))
    .sort((a, b) => b.n - a.n);
  const oMax = Math.max(1, ...outcomeRows.map((o) => o.n));

  const team = new Map<string, { name: string; leads: number; interested: number; docs: number; handed: number; hired: number }>();
  for (const l of rangeLeads) {
    const k = l.assignedTo?.id ?? "none";
    const r = team.get(k) ?? { name: l.assignedTo?.name ?? "Unassigned", leads: 0, interested: 0, docs: 0, handed: 0, hired: 0 };
    r.leads++;
    if (INTERESTED_UP.includes(l.pipelineStatus)) r.interested++;
    if (l.documentStatus === "RECEIVED") r.docs++;
    if (["HANDOFF_READY", "HANDED_OFF"].includes(l.pipelineStatus)) r.handed++;
    if (l.hireStage === "HIRED") r.hired++;
    team.set(k, r);
  }
  const teamRows = [...team.values()].sort((a, b) => b.hired - a.hired || b.interested - a.interested || b.leads - a.leads);
  const sourceRows = bySource.map((s) => ({ label: sourceLabel(s.sourceSystem), n: s._count })).sort((a, b) => b.n - a.n);
  const sMax = Math.max(1, ...sourceRows.map((s) => s.n));
  const hello = now.hour < 12 ? "Good morning" : now.hour < 18 ? "Good afternoon" : "Good evening";

  const rangeTabs: ReactNode = (
    <div className="tabs" style={{ margin: 0 }}>
      {(Object.keys(RANGES) as Range[]).map((r) => (
        <Link key={r} href={`/dashboard?range=${r}`} className={`tab ${r === range ? "on" : ""}`}>{RANGES[r]}</Link>
      ))}
    </div>
  );

  return (
    <>
      <PageHead title={`${hello}, ${user.name.split(" ")[0]}`} sub={`Recruiting overview · ${RANGES[range].toLowerCase()} · ${now.toFormat("ccc, MMM d")} (Central time)`} right={rangeTabs} />

      <div className="stats four">
        <Stat label="New leads" icon="leads" tone="blue" n={newLeads} sub={<Delta now={newLeads} prev={prevLeads} />} />
        <Stat label="AI calls placed" icon="phone" tone="violet" n={placed} sub={<Delta now={placed} prev={prevPlaced} />} />
        <Stat label="Talked to driver" icon="voice" tone="teal" n={`${pct(answered, placed)}%`} sub={<>{answered} of {placed} calls · {pickedUp - answered} picked up without a real talk (voicemail, call screening, hang-up) · <Delta now={answered} prev={prevAnswered} /></>} />
        <Stat label="Interested drivers" icon="star" tone="green" n={interestedLeads} sub={<Delta now={interestedLeads} prev={prevInterested} />} />
        <Stat label="CDL / med card received" icon="doc" tone="amber" n={docsLeads} sub={<Delta now={docsLeads} prev={prevDocs} />} />
        <Stat label="Speed to first call" icon="clock" tone="rose" n={mins(speed)} sub="median, lead in → first AI call" />
        <Stat label="Hired" icon="check" tone="green" n={hiredNow} sub={<>marked hired in this period · <Delta now={hiredNow} prev={hiredPrev} /></>} />
        <Stat label="Lead → hire" icon="jobs" tone="violet" n={`${pct(cohortHired, newLeads)}%`} sub={<>{cohortHired} of {newLeads} leads from this period hired so far · goal 6-10%</>} />
      </div>

      <div className="grid wide-left section">
        <Card title="Calls per day" right={<div className="legend"><span><i style={{ background: "var(--series-1)" }} />Talked to driver</span><span><i style={{ background: "var(--series-muted)" }} />No answer, voicemail or no real talk</span></div>}>
          <CallsChart days={days} />
          <p className="small muted" style={{ margin: "8px 0 0" }}>Last {chartDays} days, Central time. Hover a bar for the numbers.</p>
        </Card>
        <Card title="Conversion funnel">
          <div className="funnel">
            {funnel.map((f, i) => (
              <div className="funnel-row" key={f.label} style={{ gridTemplateColumns: "100px 1fr 70px" }}>
                <div className="lbl">{f.label}</div>
                <div className="bar-track" title={`${f.label}: ${f.n}`}><div className="bar-fill" style={{ width: `${(f.n / fMax) * 100}%` }} /></div>
                <div className="val"><strong>{f.n}</strong> {i > 0 && <span className="muted">{pct(f.n, funnel[0].n)}%</span>}</div>
              </div>
            ))}
          </div>
          <p className="small muted" style={{ margin: "12px 0 0" }}>Leads that came in during this period and how far each got. Percent of new leads.</p>
        </Card>
      </div>

      <div className="grid three section">
        <Card title="Call outcomes">
          {outcomeRows.map((o) => (
            <div className="hbar" key={o.label} title={`${o.label}: ${o.n}`}>
              <span>{o.label}</span><div className="bar-track"><div className="bar-fill" style={{ width: `${(o.n / oMax) * 100}%` }} /></div><span className="num">{o.n}</span>
            </div>
          ))}
          {!outcomeRows.length && <p className="muted">No calls in this period.</p>}
        </Card>
        <Card title="Lead sources">
          {sourceRows.map((s) => (
            <div className="hbar" key={s.label} title={`${s.label}: ${s.n}`} style={{ gridTemplateColumns: "150px 1fr 44px" }}>
              <span>{s.label}</span><div className="bar-track"><div className="bar-fill" style={{ width: `${(s.n / sMax) * 100}%` }} /></div><span className="num">{s.n}</span>
            </div>
          ))}
          {!sourceRows.length && <p className="muted">No new leads in this period.</p>}
        </Card>
        <Card title="AI calling cost (estimate)">
          <div className="stat" style={{ border: 0, boxShadow: "none", padding: 0 }}>
            <div className="n">${cost.toFixed(2)}</div>
            <div className="d">{billedMins} billed min · avg talk {avgTalk.toFixed(1)} min</div>
          </div>
          <table style={{ marginTop: 10 }}><tbody>
            <tr><td className="muted">Per real conversation</td><td className="num">{answered ? `$${(cost / answered).toFixed(2)}` : "—"}</td></tr>
            <tr><td className="muted">Per interested driver</td><td className="num">{interestedLeads ? `$${(cost / interestedLeads).toFixed(2)}` : "—"}</td></tr>
            <tr><td className="muted">Per CDL received</td><td className="num">{docsLeads ? `$${(cost / docsLeads).toFixed(2)}` : "—"}</td></tr>
            <tr><td className="muted">Per hire</td><td className="num">{hiredNow ? `$${(cost / hiredNow).toFixed(2)}` : "—"}</td></tr>
          </tbody></table>
          <p className="small muted" style={{ margin: "8px 0 0" }}>At ~${COST_PER_MIN.toFixed(2)}/min, every picked-up call (voicemail too). Check Telnyx billing for exact spend.</p>
        </Card>
      </div>

      <div className="grid two section">
        <Card title="Recruiter leaderboard" flush>
          <table>
            <thead><tr><th>Recruiter</th><th className="num">Leads</th><th className="num">Interested</th><th className="num">CDL in</th><th className="num">Handed off</th><th className="num">Hired</th></tr></thead>
            <tbody>
              {teamRows.map((r) => (
                <tr key={r.name}>
                  <td><div className="person"><div className="avatar">{initialsOf(r.name)}</div>{r.name}</div></td>
                  <td className="num">{r.leads}</td><td className="num">{r.interested}</td><td className="num">{r.docs}</td><td className="num">{r.handed}</td><td className="num">{r.hired}</td>
                </tr>
              ))}
              {!teamRows.length && <tr><td colSpan={6} className="muted">No new leads in this period.</td></tr>}
            </tbody>
          </table>
        </Card>
        <Card title="Needs attention" right={<Link href="/tasks" className="small">{openTasks} open task{openTasks === 1 ? "" : "s"} →</Link>}>
          {attention.map((l) => (
            <div className="attn" key={l.id}>
              <div className="person"><div className="avatar">{initials(l)}</div><div><Link href={`/leads/${l.id}`}>{name(l)}</Link><div className="small muted">{l.queueReason ?? l.phoneE164}</div></div></div>
              <Badge v={l.pipelineStatus} />
            </div>
          ))}
          {!attention.length && <p className="muted">Nothing waiting on a person right now.</p>}
        </Card>
      </div>

      {user.role === "ADMIN" && isDemo && (
        <Card title="Demo controls">
          <p className="muted">Loads 12 fictional drivers, each scripted as a different situation (interested, unknown question, opt-out, busy, wants a human, voicemail...). The background worker places simulated calls; use “Process due jobs now” if the worker is not running.</p>
          <div className="row">
            <form action={loadDemo}><button type="submit">Load synthetic demo leads</button></form>
            <form action={processNow}><button className="secondary" type="submit">Process due jobs now ({pendingJobs})</button></form>
          </div>
        </Card>
      )}

      <Card title="Recent activity">
        <ul className="feed">
          {recent.map((e) => (
            <li key={e.id}>
              <span className="when">{fmt(e.createdAt)}</span>
              <span>{e.lead ? <Link href={`/leads/${e.lead.id}`}><strong>{name(e.lead)}</strong></Link> : null} <span className="muted">·</span> {e.message}</span>
            </li>
          ))}
          {!recent.length && <li className="muted">No activity yet.</li>}
        </ul>
      </Card>
    </>
  );
}
