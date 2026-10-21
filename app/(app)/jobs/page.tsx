import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { retryDeadJob } from "@/lib/jobs/queue";
import { Badge, Card, fmt } from "@/components/ui";
import { flash } from "@/lib/flash";

async function retry(fd: FormData) {
  "use server";
  await requireAdmin();
  await retryDeadJob(String(fd.get("jobId")));
  await flash("Job queued to run again");
  revalidatePath("/jobs");
}

export default async function Jobs() {
  await requireAdmin();
  const [counts, problem, upcoming] = await Promise.all([
    db.job.groupBy({ by: ["status"], _count: true }),
    db.job.findMany({ where: { OR: [{ status: "DEAD" }, { lastError: { not: null }, status: "PENDING", attempts: { gt: 0 } }] }, orderBy: { updatedAt: "desc" }, take: 50 }),
    db.job.findMany({ where: { status: "PENDING" }, orderBy: { runAt: "asc" }, take: 30 }),
  ]);
  return (
    <>
      <h1>Background jobs</h1>
      <p className="muted">{counts.map((c) => `${c.status.toLowerCase()}: ${c._count}`).join(" · ")}</p>
      <Card title="Failures needing attention">
        <table><thead><tr><th>Job</th><th>Status</th><th>Attempts</th><th>Error</th><th></th></tr></thead><tbody>
          {problem.map((j) => <tr key={j.id}><td className="small">{j.type}</td><td><Badge v={j.status} /></td><td>{j.attempts}/{j.maxAttempts}</td><td className="small">{j.lastError}</td>
            <td>{j.status === "DEAD" && <form action={retry}><input type="hidden" name="jobId" value={j.id} /><button className="secondary">Retry safely</button></form>}</td></tr>)}
          {!problem.length && <tr><td colSpan={5} className="muted">None.</td></tr>}
        </tbody></table>
      </Card>
      <Card title="Upcoming">
        <table><thead><tr><th>Due</th><th>Job</th><th>Note</th></tr></thead><tbody>
          {upcoming.map((j) => <tr key={j.id}><td className="small">{fmt(j.runAt)}</td><td className="small">{j.type}</td><td className="small muted">{j.lastError}</td></tr>)}
        </tbody></table>
      </Card>
    </>
  );
}
