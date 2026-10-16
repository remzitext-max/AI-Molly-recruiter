import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { leadScope } from "@/lib/rbac";
import { Badge, Card, fmt, name } from "@/components/ui";

const PIPE = ["NEW", "NEEDS_PERMISSION", "NEEDS_TIMEZONE", "QUEUED", "CALLBACK_SCHEDULED", "INTERESTED", "NOT_INTERESTED", "DOCS_REQUESTED", "DOCS_RECEIVED", "HANDOFF_READY", "HANDED_OFF", "OPTED_OUT", "CLOSED"];
const DOCS = ["NONE", "REQUESTED", "RECEIVED", "EXPIRED", "DELETED"];

export default async function Leads({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const where: Prisma.LeadWhereInput = { ...leadScope(user) };
  if (sp.q) {
    const q = sp.q.trim();
    const digits = q.replace(/\D/g, "");
    where.OR = [
      { firstName: { contains: q, mode: "insensitive" } }, { lastName: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } }, ...(digits.length >= 3 ? [{ phoneE164: { contains: digits } }] : []),
    ];
  }
  if (sp.pipeline) where.pipelineStatus = sp.pipeline as Prisma.LeadWhereInput["pipelineStatus"];
  if (sp.docs) where.documentStatus = sp.docs as Prisma.LeadWhereInput["documentStatus"];
  if (sp.assigned === "me") where.assignedToId = user.id;
  else if (sp.assigned === "none") where.assignedToId = null;
  else if (sp.assigned && user.role === "ADMIN") where.assignedToId = sp.assigned;
  if (sp.data === "demo") where.isDemo = true;
  if (sp.data === "live") where.isDemo = false;
  const [leads, recruiters] = await Promise.all([
    db.lead.findMany({ where, orderBy: { updatedAt: "desc" }, take: 200, include: { assignedTo: true, calls: { orderBy: { createdAt: "desc" }, take: 1 } } }),
    user.role === "ADMIN" ? db.user.findMany({ where: { orgId: user.orgId, active: true } }) : Promise.resolve([]),
  ]);
  return (
    <>
      <div className="spread"><h1>Candidates</h1>{user.role === "ADMIN" && <Link className="btn" href="/leads/new">Add lead manually</Link>}</div>
      <Card>
        <form className="inline" method="get">
          <input name="q" placeholder="Search name, phone, email" defaultValue={sp.q} />
          <select name="pipeline" defaultValue={sp.pipeline ?? ""}><option value="">Any pipeline status</option>{PIPE.map((p) => <option key={p} value={p}>{p.replace(/_/g, " ").toLowerCase()}</option>)}</select>
          <select name="docs" defaultValue={sp.docs ?? ""}><option value="">Any document status</option>{DOCS.map((p) => <option key={p} value={p}>{p.toLowerCase()}</option>)}</select>
          <select name="assigned" defaultValue={sp.assigned ?? ""}>
            <option value="">Anyone</option><option value="me">Assigned to me</option>
            {user.role === "ADMIN" && <option value="none">Unassigned</option>}
            {recruiters.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <select name="data" defaultValue={sp.data ?? ""}><option value="">Demo + live</option><option value="demo">Demo only</option><option value="live">Live only</option></select>
          <button type="submit">Filter</button>
        </form>
      </Card>
      <Card>
        <table>
          <thead><tr><th>Candidate</th><th>Phone</th><th>Pipeline</th><th>Last call</th><th>Documents</th><th>Assigned</th><th>Next contact</th></tr></thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id}>
                <td><Link href={`/leads/${l.id}`}>{name(l)}</Link> {l.isDemo && <Badge v="DEMO" tone="demo" />}<div className="small muted">{[l.state, l.zip].filter(Boolean).join(" ")}</div></td>
                <td className="small">{l.phoneE164}</td>
                <td><Badge v={l.pipelineStatus} />{l.queueReason && <div className="small muted">{l.queueReason}</div>}</td>
                <td>{l.calls[0] ? <><Badge v={l.calls[0].status} /> <span className="small muted">{l.calls[0].outcome?.toLowerCase().replace(/_/g, " ")}</span></> : <span className="muted">—</span>}</td>
                <td><Badge v={l.documentStatus} /></td>
                <td className="small">{l.assignedTo?.name ?? <span className="muted">unassigned</span>}</td>
                <td className="small">{fmt(l.nextContactAt)}</td>
              </tr>
            ))}
            {!leads.length && <tr><td colSpan={7} className="muted">No candidates match.</td></tr>}
          </tbody>
        </table>
      </Card>
    </>
  );
}
