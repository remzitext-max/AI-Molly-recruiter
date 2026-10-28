import Link from "next/link";
import type { PipelineStatus, Prisma } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { leadScope } from "@/lib/rbac";
import { Badge, Card, PageHead, fmt, name, initials } from "@/components/ui";
import { Icon } from "@/components/icons";
import { getSettings } from "@/lib/settings";
import { answersOf, fitRulesFrom, fitScore, fitTone } from "@/lib/fit-score";
import { endedByText, whoEnded } from "@/lib/call-end";
import { config } from "@/lib/config";
import { HIRE_LABEL } from "@/lib/hiring";
import { LeadPopup } from "@/components/lead-popup";

const endedBy = (c: Parameters<typeof whoEnded>[0]) => endedByText(whoEnded(c), config.agentPersona.name);

const PIPE = ["NEW", "NEEDS_PERMISSION", "NEEDS_TIMEZONE", "QUEUED", "CALLBACK_SCHEDULED", "INTERESTED", "NOT_INTERESTED", "DOCS_REQUESTED", "DOCS_RECEIVED", "HANDOFF_READY", "HANDED_OFF", "OPTED_OUT", "CLOSED"];
const DOCS = ["NONE", "REQUESTED", "RECEIVED", "EXPIRED", "DELETED"];
// Quick views above the table; each is a set of pipeline statuses.
const VIEWS: { key: string; label: string; statuses?: string[] }[] = [
  { key: "", label: "All" },
  { key: "waiting", label: "Waiting to call", statuses: ["NEW", "QUEUED", "CONTACTING", "NEEDS_PERMISSION", "NEEDS_TIMEZONE"] },
  { key: "callback", label: "Callbacks", statuses: ["CALLBACK_SCHEDULED"] },
  { key: "interested", label: "Interested", statuses: ["INTERESTED", "DOCS_REQUESTED"] },
  { key: "docs", label: "CDL received", statuses: ["DOCS_RECEIVED", "HANDOFF_READY", "HANDED_OFF"] },
  { key: "hiring", label: "Hiring" },
  { key: "closed", label: "Closed", statuses: ["NOT_INTERESTED", "OPTED_OUT", "CLOSED"] },
];

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
  const view = VIEWS.find((v) => v.key === (sp.view ?? "")) ?? VIEWS[0];
  if (sp.pipeline) where.pipelineStatus = sp.pipeline as Prisma.LeadWhereInput["pipelineStatus"];
  else if (view.statuses) where.pipelineStatus = { in: view.statuses as PipelineStatus[] };
  if (!sp.pipeline && view.key === "hiring") where.hireStage = { not: "NONE" };
  if (sp.docs) where.documentStatus = sp.docs as Prisma.LeadWhereInput["documentStatus"];
  if (sp.assigned === "me") where.assignedToId = user.id;
  else if (sp.assigned === "none") where.assignedToId = null;
  else if (sp.assigned && user.role === "ADMIN") where.assignedToId = sp.assigned;
  if (sp.data === "demo") where.isDemo = true;
  if (sp.data === "live") where.isDemo = false;
  const [leads, recruiters, counts, hiringCount] = await Promise.all([
    db.lead.findMany({ where, orderBy: { updatedAt: "desc" }, take: 200, include: { assignedTo: true, calls: { orderBy: { createdAt: "desc" }, take: 1 }, screening: { select: { key: true, reportedValue: true, verifiedValue: true } } } }),
    user.role === "ADMIN" ? db.user.findMany({ where: { orgId: user.orgId, active: true } }) : Promise.resolve([]),
    db.lead.groupBy({ by: ["pipelineStatus"], where: leadScope(user), _count: true }),
    db.lead.count({ where: { ...leadScope(user), hireStage: { not: "NONE" } } }),
  ]);
  const rules = fitRulesFrom((await getSettings()).fitRules);
  const countOf = (v: (typeof VIEWS)[number]) => v.key === "hiring" ? hiringCount : counts.filter((c) => !v.statuses || v.statuses.includes(c.pipelineStatus)).reduce((n, c) => n + c._count, 0);
  const keep = (v: string) => { const q = new URLSearchParams(Object.entries(sp).filter(([k, x]) => x && k !== "view" && k !== "pipeline") as [string, string][]); if (v) q.set("view", v); const t = q.toString(); return t ? `/leads?${t}` : "/leads"; };
  return (
    <>
      <PageHead title="Leads" sub="Every driver Crystal is working, newest activity first. Click a driver to see the profile and download it as PDF." right={user.role === "ADMIN" && <Link className="btn" href="/leads/new"><Icon name="plus" size={16} />Add lead</Link>} />
      <div className="tabs">
        {VIEWS.map((v) => <Link key={v.key} href={keep(v.key)} className={`tab ${!sp.pipeline && v.key === view.key ? "on" : ""}`}>{v.label}<span className="c">{countOf(v)}</span></Link>)}
      </div>
      <Card>
        <form className="inline" method="get">
          {sp.view && <input type="hidden" name="view" value={sp.view} />}
          <span className="search"><Icon name="search" size={15} /><input name="q" placeholder="Search name, phone, email" defaultValue={sp.q} /></span>
          <select name="pipeline" defaultValue={sp.pipeline ?? ""}><option value="">Any pipeline status</option>{PIPE.map((p) => <option key={p} value={p}>{p.replace(/_/g, " ").toLowerCase()}</option>)}</select>
          <select name="docs" defaultValue={sp.docs ?? ""}><option value="">Any document status</option>{DOCS.map((p) => <option key={p} value={p}>{p.toLowerCase()}</option>)}</select>
          <select name="assigned" defaultValue={sp.assigned ?? ""}>
            <option value="">Anyone</option><option value="me">Assigned to me</option>
            {user.role === "ADMIN" && <option value="none">Unassigned</option>}
            {recruiters.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          {config.mode === "demo" && <select name="data" defaultValue={sp.data ?? ""}><option value="">Demo + live</option><option value="demo">Demo only</option><option value="live">Live only</option></select>}
          <button type="submit">Filter</button>
        </form>
      </Card>
      <Card flush>
        <table>
          <thead><tr><th>Lead</th><th>Phone</th><th>Fit</th><th>Pipeline</th><th>Last call</th><th>Documents</th><th>Assigned</th><th>Next contact</th></tr></thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id} data-profile={l.id} className="clickable">
                <td><div className="person"><div className="avatar">{initials(l)}</div><div><Link href={`/leads/${l.id}`} data-profile={l.id}>{name(l)}</Link> {l.isDemo && <Badge v="DEMO" tone="demo" />}<div className="small muted">{[l.state, l.zip].filter(Boolean).join(" ") || "—"}</div></div></div></td>
                <td className="small">{l.phoneE164}</td>
                <td>{(() => { const f = fitScore(answersOf(l.screening), rules); return <span className={`badge ${fitTone(f)}`} title={[...f.reasons, ...(f.missing.length ? [`Not asked yet: ${f.missing.join(", ")}`] : [])].join("\n") || f.label}>{f.score === null ? "—" : f.score}</span>; })()}</td>
                <td><Badge v={l.pipelineStatus} />{l.hireStage !== "NONE" && <> <Badge v={HIRE_LABEL[l.hireStage]} tone={l.hireStage === "HIRED" ? "ok" : ["NOT_HIRED", "SAFETY_DECLINED"].includes(l.hireStage) ? "bad" : "info"} /></>}{l.queueReason && <div className="small muted">{l.queueReason}</div>}</td>
                <td>{l.calls[0] ? <><Badge v={l.calls[0].status} /> <span className="small muted">{l.calls[0].outcome?.toLowerCase().replace(/_/g, " ")}</span>{endedBy(l.calls[0]) && <div className="small muted">{endedBy(l.calls[0])}</div>}</> : <span className="muted">—</span>}</td>
                <td><Badge v={l.documentStatus} /></td>
                <td className="small">{l.assignedTo?.name ?? <span className="muted">unassigned</span>}</td>
                <td className="small">{fmt(l.nextContactAt)}</td>
              </tr>
            ))}
            {!leads.length && <tr><td colSpan={8} className="muted">No leads match.</td></tr>}
          </tbody>
        </table>
      </Card>
      <LeadPopup />
    </>
  );
}
