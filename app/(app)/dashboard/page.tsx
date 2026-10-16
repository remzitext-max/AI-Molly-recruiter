import { revalidatePath } from "next/cache";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { leadScope } from "@/lib/rbac";
import { config } from "@/lib/config";
import { Card, Stat, Badge, fmt, name } from "@/components/ui";
import { loadDemoLeads } from "@/lib/demo-actions";
import { drainQueue } from "@/lib/jobs/queue";
import { handlers } from "@/lib/jobs/handlers";

async function loadDemo() {
  "use server";
  const u = await requireUser();
  if (u.role !== "ADMIN") throw new Error("Admin only");
  await loadDemoLeads(u.orgId, u.id);
  revalidatePath("/dashboard");
}

async function processNow() {
  "use server";
  const u = await requireUser();
  if (u.role !== "ADMIN" || config.mode !== "demo") throw new Error("Demo admin only");
  await drainQueue(handlers, "dashboard");
  revalidatePath("/dashboard");
}

export default async function Dashboard() {
  const user = await requireUser();
  const isDemo = config.mode === "demo";
  const scope = { ...leadScope(user), isDemo };
  const [attempted, connected, interested, cdl, handoffs, optedOut, queued, openTasks, recent, pendingJobs] = await Promise.all([
    db.callAttempt.count({ where: { lead: scope, status: { notIn: ["CANCELED", "SCHEDULED"] } } }),
    db.callAttempt.count({ where: { lead: scope, status: "COMPLETED" } }),
    db.lead.count({ where: { ...scope, screening: { some: { key: "offer_interest", reportedValue: "Interested" } } } }),
    db.lead.count({ where: { ...scope, documents: { some: {} } } }),
    db.handoff.findMany({ where: { lead: scope }, distinct: ["leadId"], select: { leadId: true } }).then((x) => x.length),
    db.lead.count({ where: { ...scope, pipelineStatus: "OPTED_OUT" } }),
    db.lead.count({ where: { ...scope, pipelineStatus: { in: ["QUEUED", "CALLBACK_SCHEDULED", "NEEDS_PERMISSION", "NEEDS_TIMEZONE"] } } }),
    db.task.count({ where: { status: "OPEN", lead: scope, ...(user.role === "ADMIN" ? {} : { assignedToId: user.id }) } }),
    db.activityEvent.findMany({ where: { lead: scope }, orderBy: { createdAt: "desc" }, take: 15, include: { lead: true } }),
    db.job.count({ where: { status: "PENDING", runAt: { lte: new Date() } } }),
  ]);
  return (
    <>
      <h1>Dashboard</h1>
      <div className="stats">
        <Stat n={attempted} label="Calls attempted" />
        <Stat n={connected} label="Connected conversations" />
        <Stat n={interested} label="Interested drivers" />
        <Stat n={cdl} label="CDL received" />
        <Stat n={handoffs} label="Recruiter handoffs (not hires)" />
        <Stat n={queued} label="Waiting / queued" />
        <Stat n={optedOut} label="Opted out" />
        <Stat n={openTasks} label={user.role === "ADMIN" ? "Open tasks (team)" : "My open tasks"} />
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
        <table>
          <thead><tr><th>When</th><th>Candidate</th><th>Event</th></tr></thead>
          <tbody>
            {recent.map((e) => (
              <tr key={e.id}>
                <td className="small muted">{fmt(e.createdAt)}</td>
                <td>{e.lead ? <Link href={`/leads/${e.lead.id}`}>{name(e.lead)}</Link> : "—"}</td>
                <td><Badge v={e.actorType} tone="info" /> {e.message}</td>
              </tr>
            ))}
            {!recent.length && <tr><td colSpan={3} className="muted">No activity yet.</td></tr>}
          </tbody>
        </table>
      </Card>
    </>
  );
}
