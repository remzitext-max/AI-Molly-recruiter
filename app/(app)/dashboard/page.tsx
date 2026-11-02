import { revalidatePath } from "next/cache";
import Link from "next/link";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { config } from "@/lib/config";
import { loadDemoLeads } from "@/lib/demo-actions";
import { drainQueue } from "@/lib/jobs/queue";
import { handlers } from "@/lib/jobs/handlers";
import { flash } from "@/lib/flash";
import { keepQuery, period, teamView } from "@/lib/dashboard-view";
import { DateRangePicker } from "@/components/date-range-picker";
import { Card, PageHead } from "@/components/ui";
import { LeadPopup } from "@/components/lead-popup";
import { ManagerDashboard } from "./manager";
import { RecruiterDashboard } from "./recruiter";

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

/**
 * Two dashboards: a recruiter's (their booked calls, their drivers on process, their
 * own numbers) and a manager's (the team's numbers and every recruiter's sheet
 * statuses). The owner's covers every team, or one picked above.
 */
export default async function Dashboard({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const p = period(sp);
  const manager = user.role === "ADMIN";
  const view = manager ? await teamView(user, sp.team) : null;
  const hello = p.now.hour < 12 ? "Good morning" : p.now.hour < 18 ? "Good afternoon" : "Good evening";

  const tools: ReactNode = (
    <div className="dash-tools">
      {view?.owner && view.orgs.length > 1 && (
        <div className="tabs" style={{ margin: 0 }}>
          <Link href={keepQuery("/dashboard", sp, "team", "all")} className={`tab ${view.team === "all" ? "on" : ""}`}>All teams</Link>
          {view.orgs.map((o) => <Link key={o.id} href={keepQuery("/dashboard", sp, "team", o.id)} className={`tab ${view.team === o.id ? "on" : ""}`}>{o.name}</Link>)}
        </div>
      )}
      <DateRangePicker from={p.from.toISODate()!} to={p.to.toISODate()!} today={p.now.toISODate()!} label={p.label} />
    </div>
  );
  const pendingJobs = manager && config.mode === "demo" ? await db.job.count({ where: { status: "PENDING", runAt: { lte: new Date() } } }) : 0;

  return (
    <>
      <PageHead title={`${hello}, ${user.name.split(" ")[0]}`} sub={`${view ? view.teamName : "Your drivers"} · ${p.text} (Central time)`} right={tools} />
      {view ? <ManagerDashboard user={user} view={view} p={p} /> : <RecruiterDashboard user={user} p={p} />}
      {manager && config.mode === "demo" && (
        <Card title="Demo controls">
          <p className="muted">Loads 12 fictional drivers, each scripted as a different situation (interested, unknown question, opt-out, busy, wants a human, voicemail...). The background worker places simulated calls; use “Process due jobs now” if the worker is not running.</p>
          <div className="row">
            <form action={loadDemo}><button type="submit">Load synthetic demo leads</button></form>
            <form action={processNow}><button className="secondary" type="submit">Process due jobs now ({pendingJobs})</button></form>
          </div>
        </Card>
      )}
      <LeadPopup />
    </>
  );
}
