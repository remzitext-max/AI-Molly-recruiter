import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { db } from "@/lib/db";
import { Card, PageHead, Stat, fmt } from "@/components/ui";
import { flash } from "@/lib/flash";
import { enqueue } from "@/lib/jobs/queue";
import { answerQuestionGroup, decideSuggestion, openQuestionGroups, type LearningStats } from "@/lib/learning";

const g = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const back = (orgId: string) => `/learning?org=${encodeURIComponent(orgId)}`;

async function runNow(fd: FormData) {
  "use server";
  await requireOwner();
  const orgId = g(fd, "orgId");
  await enqueue("learning.weekly", { orgId }, { idempotencyKey: `learning:${orgId}:now:${Math.floor(Date.now() / 600_000)}`, maxAttempts: 1 });
  await flash("Crystal is reviewing last week's calls. Refresh in a minute or two");
  redirect(back(orgId));
}

async function decide(fd: FormData) {
  "use server";
  const u = await requireOwner();
  const r = await decideSuggestion(u, g(fd, "id"), g(fd, "decision") === "accept", fd.has("proposed") ? g(fd, "proposed") : undefined);
  if ("error" in r) await flash(r.error!);
  else await flash(g(fd, "decision") === "accept" ? "Accepted. Crystal uses it from the next call" : "Rejected");
  revalidatePath("/learning");
  redirect(back(g(fd, "orgId")));
}

async function answer(fd: FormData) {
  "use server";
  const u = await requireOwner();
  const orgId = g(fd, "orgId");
  const r = await answerQuestionGroup(u, orgId, g(fd, "ids").split(",").filter(Boolean), g(fd, "question"), g(fd, "answer"));
  if ("error" in r) await flash(r.error!);
  else await flash(`Saved to the offer draft v${r.version}. Publish it on Offers & knowledge, then run telnyx-setup`);
  revalidatePath("/learning");
  redirect(back(orgId));
}

export default async function Learning({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const owner = await requireOwner();
  const sp = await searchParams;
  const orgs = await db.organization.findMany({ orderBy: [{ isMain: "desc" }, { createdAt: "asc" }], select: { id: true, name: true } });
  const orgId = orgs.some((o) => o.id === sp.org) ? sp.org! : owner.orgId;
  const report = await db.learningReport.findFirst({ where: { orgId }, orderBy: { createdAt: "desc" }, include: { suggestions: { orderBy: { createdAt: "asc" } } } });
  const open = await db.learningSuggestion.findMany({ where: { orgId, status: "OPEN" }, orderBy: { createdAt: "desc" }, take: 20 });
  const decided = await db.learningSuggestion.findMany({ where: { orgId, status: { not: "OPEN" } }, orderBy: { decidedAt: "desc" }, take: 10 });
  const questions = (await openQuestionGroups(orgId)).slice(0, 30);
  const st = report?.stats as LearningStats | undefined;
  return (
    <>
      <PageHead title="Crystal learning" sub="Every Monday Crystal reviews last week's calls against what recruiters marked in the sheet and suggests better wording. Nothing changes until you accept it." right={
        <form action={runNow}><input type="hidden" name="orgId" value={orgId} /><button className="secondary">Review last 7 days now</button></form>
      } />
      {orgs.length > 1 && (
        <p className="small">{orgs.map((o) => (o.id === orgId ? <b key={o.id} style={{ marginRight: 12 }}>{o.name}</b> : <Link key={o.id} href={back(o.id)} style={{ marginRight: 12 }}>{o.name}</Link>))}</p>
      )}
      <Card title={report ? `Last review: ${fmt(report.periodStart)} – ${fmt(report.periodEnd)}` : "No review yet"}>
        {st ? (
          <>
            <div className="stats four">
              <Stat n={st.talked} label="Calls where the driver talked" />
              <Stat n={st.good} label="Moved forward" sub={st.goodRate === null ? "" : `${st.goodRate}% of talks`} tone="green" />
              <Stat n={st.hired} label="Hired this week" tone="violet" />
              <Stat n={st.openQuestions} label="Questions Crystal couldn't answer" tone="amber" />
            </div>
            {report?.summary && <p style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>{report.summary}</p>}
            {report?.error && <p className="small bad-text">AI review failed: {report.error}</p>}
            {st.dropOffs.length > 0 && (
              <>
                <p className="small" style={{ marginTop: 12 }}><b>Crystal's last line before drivers hung up</b></p>
                <ul className="small">{st.dropOffs.map((d) => <li key={d.line}>&ldquo;{d.line}&rdquo; ({d.count}×)</li>)}</ul>
              </>
            )}
          </>
        ) : <p className="muted small">The first review runs next Monday, or press &ldquo;Review last 7 days now&rdquo;.</p>}
      </Card>
      <Card title={`Suggestions to decide (${open.length})`}>
        {open.length === 0 && <p className="muted small">Nothing waiting.</p>}
        {open.map((s) => (
          <form key={s.id} action={decide} style={{ borderTop: "1px solid var(--border, #e5e7eb)", paddingTop: 12, marginTop: 12 }}>
            <input type="hidden" name="id" value={s.id} />
            <input type="hidden" name="orgId" value={orgId} />
            <p><b>{s.title}</b>{s.field && <span className="small muted"> · changes the pitch field &ldquo;{s.field}&rdquo;</span>}</p>
            <p className="small">{s.why}</p>
            {s.field && s.proposed && <textarea name="proposed" defaultValue={s.proposed} rows={3} />}
            {!s.field && s.proposed && <p className="small muted">{s.proposed}</p>}
            <div className="inline" style={{ marginTop: 8 }}>
              <button name="decision" value="accept">{s.field ? "Accept" : "Got it"}</button>
              <button name="decision" value="reject" className="secondary">Reject</button>
            </div>
          </form>
        ))}
      </Card>
      <Card title={`Questions Crystal couldn't answer (${questions.length})`}>
        <p className="small muted">Answer once: it goes into the offer draft. After you publish the draft on Offers &amp; knowledge and run telnyx-setup, Crystal answers it herself.</p>
        {questions.map((q) => (
          <form key={q.ids[0]} action={answer} style={{ borderTop: "1px solid var(--border, #e5e7eb)", paddingTop: 10, marginTop: 10 }}>
            <input type="hidden" name="orgId" value={orgId} />
            <input type="hidden" name="ids" value={q.ids.join(",")} />
            <input type="hidden" name="question" value={q.question} />
            <p><b>{q.question}</b> <span className="small muted">asked {q.ids.length}× · last {fmt(q.last)}</span></p>
            <div className="inline"><input name="answer" placeholder="The approved answer Crystal may say" autoComplete="off" style={{ flex: 1 }} /><button className="secondary">Save answer</button></div>
          </form>
        ))}
      </Card>
      {decided.length > 0 && (
        <Card title="Decided">
          <ul className="small">{decided.map((s) => <li key={s.id}>{s.status === "ACCEPTED" ? "✅" : "✖️"} {s.title} <span className="muted">({fmt(s.decidedAt)})</span></li>)}</ul>
        </Card>
      )}
    </>
  );
}
