import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { leadScope, assertLeadAccess } from "@/lib/rbac";
import { recordEvent } from "@/lib/activity";
import { formatLocal } from "@/lib/timezone";
import { Badge, Card, fmt, name } from "@/components/ui";
import { flash } from "@/lib/flash";

async function complete(fd: FormData) {
  "use server";
  const u = await requireUser();
  const t = await db.task.findUniqueOrThrow({ where: { id: String(fd.get("taskId")) } });
  await assertLeadAccess(u, t.leadId);
  await db.task.update({ where: { id: t.id }, data: { status: "DONE", completedAt: new Date(), notes: [t.notes, fd.get("note") ? `Done: ${fd.get("note")}` : null].filter(Boolean).join("\n") } });
  await recordEvent({ leadId: t.leadId, actorType: "USER", actorId: u.id, type: "TASK_DONE", message: `Task completed: ${t.title}` });
  await flash("Task marked as done");
  revalidatePath("/tasks");
}

export default async function Tasks({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const u = await requireUser();
  const sp = await searchParams;
  const tasks = await db.task.findMany({
    where: { status: "OPEN", lead: leadScope(u), ...(u.role === "ADMIN" && sp.all ? {} : u.role === "ADMIN" ? {} : { assignedToId: u.id }) },
    include: { lead: true, assignedTo: true },
    orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
  });
  return (
    <>
      <h1>Follow-up tasks</h1>
      <Card>
        <table>
          <thead><tr><th>Due</th><th>Task</th><th>Lead</th><th>Assigned</th><th></th></tr></thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td className="small">{t.dueAt ? <>{fmt(t.dueAt)}<div className="muted">{formatLocal(t.dueAt, t.lead.timezone)} driver</div></> : "—"}</td>
                <td><Badge v={t.type} tone="info" /> {t.title}{t.notes && <div className="small muted">{t.notes}</div>}</td>
                <td><Link href={`/leads/${t.leadId}`}>{name(t.lead)}</Link></td>
                <td className="small">{t.assignedTo?.name ?? "unassigned"}</td>
                <td><form action={complete} className="inline"><input type="hidden" name="taskId" value={t.id} /><input name="note" placeholder="note" size={12} /><button className="secondary">Done</button></form></td>
              </tr>
            ))}
            {!tasks.length && <tr><td colSpan={5} className="muted">No open tasks.</td></tr>}
          </tbody>
        </table>
      </Card>
    </>
  );
}
