// A recruiter's dashboard: booked calls first (they stay until the call is made), then
// their own numbers, their drivers on process and their leads by sheet status.
import Link from "next/link";
import { revalidatePath } from "next/cache";
import type { User } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { config } from "@/lib/config";
import { flash } from "@/lib/flash";
import { formatLocal } from "@/lib/timezone";
import { officeClock } from "@/lib/office-hours";
import { dashboardScope, talkedDrivers } from "@/lib/talked";
import { markCallMade, scheduledCalls } from "@/lib/scheduled-calls";
import { loadOnProcess } from "@/lib/on-process";
import { orderStatuses, tabStats } from "@/lib/sheet-rows";
import { statusTone } from "@/lib/recruiter-status";
import { RECALL_PREFIX } from "@/lib/sheet-recall";
import { pct, type Period } from "@/lib/dashboard-view";
import { Card, Stat, fmt, initialsOf } from "@/components/ui";
import { BarRow } from "@/components/dash-parts";
import { CallNow } from "@/components/call-now";

async function callMade(fd: FormData) {
  "use server";
  const u = await requireUser();
  await markCallMade(u, String(fd.get("taskId")));
  await flash("Call marked as made");
  revalidatePath("/dashboard");
}

const fullName = (l: { firstName: string | null; lastName: string | null }) => [l.firstName, l.lastName].filter(Boolean).join(" ") || "(no name)";

export async function RecruiterDashboard({ user, p }: { user: Pick<User, "id" | "role" | "orgId" | "name">; p: Period }) {
  const scope = dashboardScope(user, true, config.mode === "demo");
  const fresh = { sourceRecords: { none: { sourceRecordId: { startsWith: RECALL_PREFIX } } } };
  const [calls, newLeads, talked, interested, docs, onProcess, tabs] = await Promise.all([
    scheduledCalls(user),
    db.lead.count({ where: { ...scope, ...fresh, createdAt: p.range } }),
    talkedDrivers(scope, p.range),
    db.callAttempt.findMany({ where: { lead: scope, outcome: "INTERESTED", createdAt: p.range }, distinct: ["leadId"], select: { leadId: true } }).then((x) => x.length),
    db.document.findMany({ where: { lead: scope, uploadedAt: p.range }, distinct: ["leadId"], select: { leadId: true } }).then((x) => x.length),
    loadOnProcess(user),
    tabStats([user.orgId], p.range),
  ]);
  const mine = tabs.filter((t) => t.recruiterId === user.id);
  const byStatus: Record<string, number> = {};
  for (const t of mine) for (const [s, n] of Object.entries(t.byStatus)) byStatus[s] = (byStatus[s] ?? 0) + n;
  const statuses = orderStatuses(Object.keys(byStatus));
  const sheetTotal = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...Object.values(byStatus));
  const now = Date.now();

  return (
    <>
      <div className={`calls-due${calls.length ? "" : " empty"}`}>
        <div className="calls-due-head">
          <span className="chip"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" /></svg></span>
          <div>
            <h2>{calls.length ? `You have ${calls.length} scheduled call${calls.length === 1 ? "" : "s"}` : "No scheduled calls"}</h2>
            <div className="small muted">{calls.length ? "Drivers who asked for a recruiter. Each stays here until you mark the call made." : "When Crystal books a call for you, it shows up here."}</div>
          </div>
        </div>
        {calls.map((t) => {
          const late = t.dueAt!.getTime() < now;
          return (
            <div className={`call-row${late ? " late" : ""}`} key={t.id}>
              <div className="person">
                <div className="avatar">{initialsOf(fullName(t.lead))}</div>
                <div>
                  <a href={`/leads/${t.lead.id}`} data-profile={t.lead.id}><strong>{fullName(t.lead)}</strong></a> <span className="small muted">{t.lead.phoneE164}</span>
                  <div className="small"><strong className={late ? "bad-text" : ""}>{late ? "Overdue · " : ""}{officeClock(t.dueAt!)} Tashkent</strong> <span className="muted">({formatLocal(t.dueAt!, t.lead.timezone)} driver time)</span></div>
                  {t.notes && <div className="small muted">“{t.notes}”</div>}
                </div>
              </div>
              <div className="row">
                <CallNow phone={t.lead.phoneE164} />
                <form action={callMade}><input type="hidden" name="taskId" value={t.id} /><button className="secondary" type="submit">Call made</button></form>
              </div>
            </div>
          );
        })}
      </div>

      <div className="stats six">
        <Stat label="My new leads" icon="leads" tone="blue" n={newLeads} sub="assigned to you in this period" />
        <Stat label="Talked to Crystal" icon="voice" tone="teal" n={talked.length} sub={<Link href={`/talked?${new URLSearchParams({ since: p.since.toISOString(), until: p.until.toISOString(), who: "mine" })}`}>see who</Link>} />
        <Stat label="Interested" icon="star" tone="green" n={interested} sub="said yes to Crystal" />
        <Stat label="CDL / med card in" icon="doc" tone="amber" n={docs} />
        <Stat label="On process now" icon="check" tone="violet" n={onProcess.length} sub={<Link href="/process">open the list</Link>} />
        <Stat label="Hired" icon="check" tone="green" n={(byStatus["Hired"] ?? 0) + (byStatus["Our driver – working"] ?? 0)} sub="sheet status, applied in this period" />
      </div>

      <div className="grid two section">
        <Card title={`On process (${onProcess.length})`} flush right={<Link className="small" href="/process" style={{ marginRight: 14 }}>All →</Link>}>
          <table>
            <thead><tr><th>Driver</th><th>Status</th><th>Since</th></tr></thead>
            <tbody>
              {onProcess.slice(0, 12).map((d) => (
                <tr key={d.key} {...(d.leadId ? { "data-profile": d.leadId, className: "clickable" } : {})}>
                  <td><div className="person"><div className="avatar">{initialsOf(d.name)}</div><div>{d.name}<div className="small muted">{d.phone}</div></div></div></td>
                  <td><span className={`badge ${statusTone(d.status)}`}>{d.status}</span></td>
                  <td className="small">{d.since ? fmt(d.since) : "—"}</td>
                </tr>
              ))}
              {!onProcess.length && <tr><td colSpan={3} className="muted">No drivers with Need to bring, Need approval or Application.</td></tr>}
            </tbody>
          </table>
        </Card>
        <Card title="My leads by sheet status">
          {statuses.map((s) => <BarRow key={s} label={<span className={`badge ${statusTone(s)}`}>{s}</span>} n={byStatus[s]} max={max} total={sheetTotal} href={`/leads?status=${encodeURIComponent(s)}`} cols="150px 1fr 80px" />)}
          {!statuses.length && <p className="muted">No drivers in your sheet tab applied in this period.</p>}
          {sheetTotal > 0 && <p className="small muted" style={{ margin: "10px 0 0" }}>{sheetTotal} drivers in your tab applied in this period; you reached {pct(sheetTotal - (byStatus["New"] ?? 0) - (byStatus["No answer"] ?? 0) - (byStatus["Not in service"] ?? 0), sheetTotal)}%.</p>}
        </Card>
      </div>
    </>
  );
}
