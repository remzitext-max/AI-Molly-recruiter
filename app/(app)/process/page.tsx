import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Card, PageHead, fmt, initialsOf } from "@/components/ui";
import { LeadPopup } from "@/components/lead-popup";
import { statusTone } from "@/lib/recruiter-status";
import { ON_PROCESS, loadOnProcess } from "@/lib/on-process";

export default async function OnProcess({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  // A recruiter sees their own drivers; a manager sees every recruiter's, with the recruiter's name.
  const manager = user.role === "ADMIN";
  const all = await loadOnProcess(user);
  const recruiters = [...new Set(all.map((d) => d.recruiter ?? "No recruiter"))].sort();
  const byRecruiter = manager && sp.recruiter ? all.filter((d) => (d.recruiter ?? "No recruiter") === sp.recruiter) : all;
  const rows = sp.status ? byRecruiter.filter((d) => d.status === sp.status) : byRecruiter;
  const href = (status?: string) => {
    const q = new URLSearchParams();
    if (status) q.set("status", status);
    if (sp.recruiter) q.set("recruiter", sp.recruiter);
    const t = q.toString();
    return t ? `/process?${t}` : "/process";
  };
  return (
    <>
      <PageHead
        title="On process"
        sub={`${manager ? "Every recruiter's drivers" : "Your drivers"} with Need to bring, Need approval or Application status, from the lead sheet tabs (updated every 15 minutes) and from the site.`}
      />
      <div className="tabs">
        <Link href={href()} className={`tab ${!sp.status ? "on" : ""}`}>All<span className="c">{byRecruiter.length}</span></Link>
        {ON_PROCESS.map((s) => <Link key={s} href={href(s)} className={`tab ${sp.status === s ? "on" : ""}`}>{s}<span className="c">{byRecruiter.filter((d) => d.status === s).length}</span></Link>)}
      </div>
      {manager && (
        <Card>
          <form className="inline" method="get">
            {sp.status && <input type="hidden" name="status" value={sp.status} />}
            <select name="recruiter" defaultValue={sp.recruiter ?? ""}>
              <option value="">Every recruiter</option>
              {recruiters.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button type="submit">Show</button>
          </form>
        </Card>
      )}
      <Card flush>
        <table>
          <thead><tr><th>Driver</th><th>Phone</th><th>Status</th>{manager && <th>Recruiter</th>}<th>Experience</th><th>Documents</th><th>Status since</th></tr></thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.key} {...(d.leadId ? { "data-profile": d.leadId, className: "clickable" } : {})}>
                <td><div className="person"><div className="avatar">{initialsOf(d.name)}</div><div>{d.leadId ? <Link href={`/leads/${d.leadId}`} data-profile={d.leadId}>{d.name}</Link> : d.name}<div className="small muted">{d.tab ? `${d.tab} tab` : "set on the site"}</div></div></div></td>
                <td className="small">{d.phone}</td>
                <td><span className={`badge ${statusTone(d.status)}`}>{d.status}</span></td>
                {manager && <td className="small">{d.recruiter ?? <span className="muted">no recruiter</span>}</td>}
                <td className="small">{d.experience || "—"}</td>
                <td className="small">{d.documents ?? <span className="muted">not a Crystal lead</span>}</td>
                <td className="small">{fmt(d.since)}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={manager ? 7 : 6} className="muted">No drivers on process.</td></tr>}
          </tbody>
        </table>
      </Card>
      <LeadPopup />
    </>
  );
}
