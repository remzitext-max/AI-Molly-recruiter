import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertAdmin, assertLeadAccess, leadScope } from "@/lib/rbac";
import { assignLead } from "@/lib/assignment";
import { optOutLead, scheduleLeadCall, stopAiCalls } from "@/lib/leads";
import { deleteDocument } from "@/lib/documents";
import { sendCdlLink } from "@/lib/messaging";
import { recordEvent } from "@/lib/activity";
import { isValidTimezone, formatLocal } from "@/lib/timezone";
import { config } from "@/lib/config";

const endedBy = (c: Parameters<typeof whoEnded>[0]) => endedByText(whoEnded(c), config.agentPersona.name);
import { PERSONAS } from "@/lib/conversation/personas";
import { getAdapters } from "@/adapters/registry";
import { readDemoOutbox } from "@/adapters/mock";
import { Badge, Card, fmt, name, initials } from "@/components/ui";
import { getSettings } from "@/lib/settings";
import { answersOf, fitRulesFrom, fitScore, fitTone } from "@/lib/fit-score";
import { endedByText, whoEnded } from "@/lib/call-end";

type Turn = { speaker: string; text: string; latencyMs?: number };

async function guard(leadId: string) {
  const u = await requireUser();
  await assertLeadAccess(u, leadId);
  return u;
}

async function assign(fd: FormData) {
  "use server";
  const id = String(fd.get("leadId"));
  const u = await guard(id);
  assertAdmin(u);
  const to = String(fd.get("userId") || "") || null;
  await assignLead(id, to, "MANUAL", u.id);
  revalidatePath(`/leads/${id}`);
}

async function schedule(fd: FormData) {
  "use server";
  const id = String(fd.get("leadId"));
  const u = await guard(id);
  const at = fd.get("at") ? new Date(String(fd.get("at"))) : undefined;
  const persona = config.mode === "demo" ? String(fd.get("persona") || "") || undefined : undefined;
  await db.lead.update({ where: { id }, data: { attemptCount: 0 } }).catch(() => {});
  await scheduleLeadCall(id, { at, reason: `Scheduled by ${u.name}`, personaKey: persona });
  await recordEvent({ leadId: id, actorType: "USER", actorId: u.id, type: "CALL_SCHEDULED", message: `AI call scheduled${at ? ` for ${at.toISOString()}` : ""} (contact rules still apply)` });
  revalidatePath(`/leads/${id}`);
}

async function stopCalls(fd: FormData) {
  "use server";
  const id = String(fd.get("leadId"));
  const u = await guard(id);
  await stopAiCalls(id, { id: u.id, name: u.name });
  revalidatePath(`/leads/${id}`);
}

async function optOut(fd: FormData) {
  "use server";
  const id = String(fd.get("leadId"));
  const u = await guard(id);
  await optOutLead(id, `Marked by ${u.name}`, { type: "USER", id: u.id });
  revalidatePath(`/leads/${id}`);
}

async function addPermission(fd: FormData) {
  "use server";
  const id = String(fd.get("leadId"));
  const u = await guard(id);
  const scope = String(fd.get("scope")) as "AI_CALL" | "SMS" | "MANUAL_CALL";
  const source = String(fd.get("source") || "").trim();
  const grantedAt = new Date(String(fd.get("grantedAt")));
  if (!source || isNaN(grantedAt.getTime())) throw new Error("Source and date are required");
  const lead = await db.lead.findUniqueOrThrow({ where: { id } });
  if (lead.optedOutAt) throw new Error("Driver opted out; permission cannot be re-added here");
  await db.contactPermission.create({ data: { leadId: id, scope, source, grantedAt, evidence: String(fd.get("evidence") || "") || null, isDemo: lead.isDemo, createdById: u.id } });
  await recordEvent({ leadId: id, actorType: "USER", actorId: u.id, type: "PERMISSION", message: `${scope} permission recorded: ${source} (${grantedAt.toISOString().slice(0, 10)})` });
  if (lead.pipelineStatus === "NEEDS_PERMISSION") {
    await db.lead.update({ where: { id }, data: { pipelineStatus: "NEW" } });
    await scheduleLeadCall(id, { reason: "Permission recorded" });
  }
  await db.task.updateMany({ where: { leadId: id, type: "RECORD_PERMISSION", status: "OPEN" }, data: { status: "DONE", completedAt: new Date() } });
  revalidatePath(`/leads/${id}`);
}

async function setTimezone(fd: FormData) {
  "use server";
  const id = String(fd.get("leadId"));
  const u = await guard(id);
  const tz = String(fd.get("timezone"));
  if (!isValidTimezone(tz)) throw new Error("Invalid timezone");
  const lead = await db.lead.update({ where: { id }, data: { timezone: tz, timezoneSource: "MANUAL" } });
  await recordEvent({ leadId: id, actorType: "USER", actorId: u.id, type: "TIMEZONE", message: `Timezone set to ${tz}` });
  await db.task.updateMany({ where: { leadId: id, type: "RESOLVE_TIMEZONE", status: "OPEN" }, data: { status: "DONE", completedAt: new Date() } });
  if (lead.pipelineStatus === "NEEDS_TIMEZONE") {
    await db.lead.update({ where: { id }, data: { pipelineStatus: "NEW" } });
    await scheduleLeadCall(id, { reason: "Timezone resolved" });
  }
  revalidatePath(`/leads/${id}`);
}

async function verifyField(fd: FormData) {
  "use server";
  const id = String(fd.get("leadId"));
  const u = await guard(id);
  const key = String(fd.get("key"));
  const value = String(fd.get("verifiedValue") || "").trim();
  await db.screeningField.update({ where: { leadId_key: { leadId: id, key } }, data: { verifiedValue: value || null, verifiedById: value ? u.id : null, verifiedAt: value ? new Date() : null } });
  await recordEvent({ leadId: id, actorType: "USER", actorId: u.id, type: "VERIFIED", message: `${key.replace(/_/g, " ")} ${value ? "verified by recruiter" : "verification cleared"}` });
  revalidatePath(`/leads/${id}`);
}

async function delDoc(fd: FormData) {
  "use server";
  const id = String(fd.get("leadId"));
  const u = await guard(id);
  assertAdmin(u);
  await deleteDocument(String(fd.get("documentId")), { type: "USER", id: u.id }, `deleted by ${u.name}`);
  revalidatePath(`/leads/${id}`);
}

async function sendLink(fd: FormData) {
  "use server";
  const id = String(fd.get("leadId"));
  const u = await guard(id);
  const r = await sendCdlLink(id, null, { verbalConsent: false });
  await recordEvent({ leadId: id, actorType: "USER", actorId: u.id, type: "CDL_LINK_REQUEST", message: r.sent ? "Recruiter sent CDL upload link" : `CDL link not sent: ${r.reason}` });
  revalidatePath(`/leads/${id}`);
}

async function closeQuestion(fd: FormData) {
  "use server";
  const id = String(fd.get("leadId"));
  const u = await guard(id);
  await db.unansweredQuestion.update({ where: { id: String(fd.get("questionId")) }, data: { status: "ANSWERED", answer: String(fd.get("answer") || "") || null } });
  await recordEvent({ leadId: id, actorType: "USER", actorId: u.id, type: "QUESTION_ANSWERED", message: "Recruiter answered a driver question" });
  revalidatePath(`/leads/${id}`);
}

async function clickToCall(fd: FormData) {
  "use server";
  const id = String(fd.get("leadId"));
  const u = await guard(id);
  const lead = await db.lead.findUniqueOrThrow({ where: { id } });
  if (lead.optedOutAt) throw new Error("Driver opted out");
  if (!u.transferPhoneE164) throw new Error("Set your phone number on the Users page first");
  if (config.mode === "live" && lead.isDemo) throw new Error("Demo record");
  const t = getAdapters().telephony;
  try {
    const r = await t.connectRecruiterToDriver(u.transferPhoneE164, lead.phoneE164);
    await recordEvent({ leadId: id, actorType: "USER", actorId: u.id, type: "RECRUITER_CALL", message: `Click-to-call requested via ${t.key}${t.isMock ? " (MOCK, no call placed)" : ""}`, data: { ref: r.providerRef } });
  } catch (e) {
    await recordEvent({ leadId: id, actorType: "USER", actorId: u.id, type: "RECRUITER_CALL_FAILED", message: `Click-to-call failed: ${(e as Error).message}` });
  }
  revalidatePath(`/leads/${id}`);
}

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const lead = await db.lead.findFirst({
    where: { id, ...leadScope(user) },
    include: {
      assignedTo: true, campaign: true, sourceRecords: true, permissions: { orderBy: { createdAt: "desc" } },
      screening: { orderBy: { key: "asc" } }, calls: { orderBy: { createdAt: "desc" } }, messages: { orderBy: { createdAt: "desc" } },
      documents: { orderBy: { uploadedAt: "desc" } }, tasks: { orderBy: { createdAt: "desc" }, include: { assignedTo: true } },
      handoffs: { orderBy: { createdAt: "desc" } }, questions: { orderBy: { createdAt: "desc" } },
      events: { orderBy: { createdAt: "desc" }, take: 100 }, assignments: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!lead) notFound();
  const recruiters = user.role === "ADMIN" ? await db.user.findMany({ where: { orgId: user.orgId, active: true } }) : [];
  const offerVersions = await db.offerVersion.findMany({ where: { id: { in: lead.calls.map((c) => c.offerVersionId).filter(Boolean) as string[] } }, include: { offer: true } });
  const ov = (vid: string | null) => offerVersions.find((o) => o.id === vid);
  const hidden = <input type="hidden" name="leadId" value={lead.id} />;
  const fit = fitScore(answersOf(lead.screening), fitRulesFrom((await getSettings()).fitRules));
  const demoPhone = lead.isDemo ? (await readDemoOutbox(lead.phoneE164)).slice(-1)[0] : undefined;

  return (
    <>
      <div className="spread" style={{ marginBottom: 18 }}>
        <div className="profile">
          <div className="avatar">{initials(lead)}</div>
          <div><h1 style={{ margin: 0 }}>{name(lead)} {lead.isDemo && <Badge v="DEMO" tone="demo" />}</h1><div className="muted">{lead.phoneE164}{lead.state ? ` · ${lead.state}` : ""} · added {fmt(lead.createdAt)}</div></div>
        </div>
        <div className="row">
          <Badge v={lead.pipelineStatus} /> <span className="small muted">pipeline</span>
          <Badge v={lead.documentStatus} /> <span className="small muted">CDL</span>
        </div>
      </div>
      {lead.optedOutAt && <div className="alert error">Opted out on {fmt(lead.optedOutAt)}. No automated calls or texts will be sent; the number is suppressed for future imports.</div>}

      <div className="grid two">
        <Card title="Driver">
          <table className="kv"><tbody>
            <tr><th>Phone</th><td>{lead.phoneE164}</td></tr>
            <tr><th>Email</th><td>{lead.email ?? "—"}</td></tr>
            <tr><th>Location</th><td>{[lead.state, lead.zip].filter(Boolean).join(" ") || "—"}</td></tr>
            <tr><th>Timezone</th><td>{lead.timezone ?? <Badge v="UNKNOWN" />} <span className="small muted">{lead.timezoneSource?.toLowerCase()}</span></td></tr>
            <tr><th>Campaign</th><td>{lead.campaign.name}</td></tr>
            <tr><th>Assigned</th><td>{lead.assignedTo?.name ?? "unassigned"}</td></tr>
            <tr><th>Call attempts</th><td>{lead.attemptCount} / {lead.campaign.maxAttempts}</td></tr>
            <tr><th>Next contact</th><td>{fmt(lead.nextContactAt)} {lead.queueReason && <div className="small muted">{lead.queueReason}</div>}</td></tr>
            <tr><th>Agreed callback</th><td>{lead.callbackAt ? `${formatLocal(lead.callbackAt, lead.timezone)} (driver local)` : "—"}</td></tr>
            {user.role === "ADMIN" && lead.fbCampaign && <tr><th>Facebook ad</th><td className="small">{lead.fbCampaign}{lead.fbAd ? ` · ${lead.fbAd}` : ""}{lead.fbForm ? <div className="muted">form: {lead.fbForm}</div> : null}</td></tr>}
            <tr><th>Sources</th><td className="small">{lead.sourceRecords.map((s) => <div key={s.id}>{s.sourceSystem}: {s.sourceRecordId} <span className="muted">sync: {s.syncStatus?.toLowerCase().replace(/_/g, " ") ?? "—"}</span></div>)}</td></tr>
          </tbody></table>
        </Card>
        <Card title="Actions">
          {user.role === "ADMIN" && (
            <form action={assign} className="inline">{hidden}
              <select name="userId" defaultValue={lead.assignedToId ?? ""}><option value="">Unassigned</option>{recruiters.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
              <button className="secondary">Assign</button>
            </form>
          )}
          {!lead.optedOutAt && (
            <>
              <h3>Schedule AI call</h3>
              <form action={schedule} className="inline">{hidden}
                <input type="datetime-local" name="at" title="Leave empty for as soon as permitted" />
                {config.mode === "demo" && <select name="persona">{PERSONAS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select>}
                <button>Schedule</button>
              </form>
              <p className="small muted">Permission, contact hours, pause switches and attempt limits are checked again when the call is due.</p>
              <h3>Recruiter actions</h3>
              <div className="row">
                <form action={sendLink}>{hidden}<button className="secondary">Text CDL / med card request</button></form>
                <form action={clickToCall}>{hidden}<button className="secondary">Call from my phone</button></form>
                <form action={stopCalls}>{hidden}<button className="secondary">Stop AI calls</button></form>
                <form action={optOut}>{hidden}<button className="danger">Opt out / stop contact</button></form>
              </div>
            </>
          )}
          <h3>Timezone</h3>
          <form action={setTimezone} className="inline">{hidden}
            <select name="timezone" defaultValue={lead.timezone ?? ""}>
              <option value="" disabled>Choose…</option>
              {["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "America/Indiana/Indianapolis", "America/Detroit", "America/Boise"].map((t) => <option key={t}>{t}</option>)}
            </select>
            <button className="secondary">Set</button>
          </form>
        </Card>
      </div>

      <Card title="Fit score" right={<span className={`badge ${fitTone(fit)}`} style={{ fontSize: 13 }}>{fit.score === null ? fit.label : `${fit.score}/100 · ${fit.label}`}</span>}>
        {fit.reasons.length > 0 && <ul style={{ margin: "0 0 6px", paddingLeft: 18 }}>{fit.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
        {fit.missing.length > 0 && <p className="small muted" style={{ margin: 0 }}>Not answered yet: {fit.missing.join(", ")}.</p>}
        {!fit.reasons.length && !fit.missing.length && <p className="small muted" style={{ margin: 0 }}>Meets the requirements set in Settings, based on the driver’s own answers.</p>}
        <p className="small muted" style={{ margin: "6px 0 0" }}>A guide for recruiters from driver-reported answers (verified values win). Not a hiring decision.</p>
      </Card>

      <Card title="Screening (driver-reported vs verified)">
        <p className="small muted">Driver-reported answers are unverified. Verified values are entered only by the recruiter/Safety team after official checks. This system performs no MVR, PSP/PEV or Clearinghouse checks.</p>
        <table>
          <thead><tr><th>Field</th><th>Driver reported</th><th>Status</th><th>Verified (human)</th></tr></thead>
          <tbody>
            {lead.screening.map((s) => (
              <tr key={s.id}>
                <td>{s.key.replace(/_/g, " ")}</td>
                <td>{s.reportedValue}{s.rawUtterance && s.status === "UNCLEAR" && <div className="small muted">“{s.rawUtterance}”</div>}</td>
                <td><Badge v={s.status} /></td>
                <td>
                  <form action={verifyField} className="inline">{hidden}<input type="hidden" name="key" value={s.key} />
                    <input name="verifiedValue" defaultValue={s.verifiedValue ?? ""} placeholder="not verified" size={18} /><button className="secondary">Save</button>
                  </form>
                </td>
              </tr>
            ))}
            {!lead.screening.length && <tr><td colSpan={4} className="muted">Nothing collected yet.</td></tr>}
          </tbody>
        </table>
      </Card>

      {lead.questions.length > 0 && (
        <Card title="Driver questions for Molly">
          <table><tbody>
            {lead.questions.map((q) => (
              <tr key={q.id}><td>“{q.question}”</td><td><Badge v={q.status} /></td>
                <td>{q.status === "OPEN" ? <form action={closeQuestion} className="inline">{hidden}<input type="hidden" name="questionId" value={q.id} /><input name="answer" placeholder="Answer given (optional)" /><button className="secondary">Mark answered</button></form> : <span className="small">{q.answer}</span>}</td></tr>
            ))}
          </tbody></table>
        </Card>
      )}

      <Card title="Calls">
        {lead.calls.map((c) => (
          <div key={c.id} id={`call-${c.id}`} style={{ borderTop: "1px solid var(--border)", paddingTop: 10, marginTop: 10 }}>
            <div className="row">
              <strong>{fmt(c.createdAt)}</strong> <Badge v={c.status} /> {c.outcome && <Badge v={c.outcome} />}
              {c.isDemo && <Badge v="SIMULATED" tone="demo" />} {endedBy(c) && <strong className="small">{endedBy(c)}</strong>} <span className="small muted">provider: {c.provider}</span>
              {ov(c.offerVersionId) && <span className="small muted">offer: {ov(c.offerVersionId)!.offer.name} v{ov(c.offerVersionId)!.version}{ov(c.offerVersionId)!.synthetic ? " (synthetic)" : ""}</span>}
            </div>
            {c.summary && <p>{c.summary}</p>}
            {c.errorMessage && <p className="small" style={{ color: "var(--bad)" }}>{c.errorMessage}</p>}
            {c.metrics && <p className="small muted">Metrics: {JSON.stringify(c.metrics)}</p>}
            {Array.isArray(c.transcript) && (
              <details><summary>Transcript ({(c.transcript as Turn[]).length} turns)</summary>
                <div className="transcript">
                  {(c.transcript as Turn[]).map((t, i) => <div key={i} className={`turn ${t.speaker}`}><span className="who">{t.speaker === "agent" ? "AI" : "Driver"}</span>{t.text}</div>)}
                </div>
              </details>
            )}
            {c.recordingKey ? <audio controls preload="none" src={`/api/recordings/${c.id}`} style={{ width: "100%" }} /> : <p className="small muted">No recording.</p>}
          </div>
        ))}
        {!lead.calls.length && <p className="muted">No calls yet.</p>}
      </Card>

      <div className="grid two">
        <Card title="Documents (private)">
          {lead.documents.map((d) => (
            <div key={d.id} className="spread" style={{ marginBottom: 8 }}>
              <div>
                {d.deletedAt ? <span className="muted">Deleted {fmt(d.deletedAt)}</span> : <a href={`/api/documents/${d.id}`} target="_blank" rel="noreferrer">View {d.kind === "MED_CARD" ? "medical card" : "CDL"} ({d.mimeType}, {Math.round(d.sizeBytes / 1024)} KB)</a>}
                <div className="small muted">Uploaded {fmt(d.uploadedAt)} · auto-delete {fmt(d.deleteAfter)}</div>
                {d.extraction && !d.deletedAt && (() => {
                  const ex = d.extraction as { fields?: { name: string; value: string | null }[]; warnings?: string[] };
                  const fields = (ex.fields ?? []).filter((f) => f.value);
                  return (
                    <div className="small" style={{ marginTop: 4 }}>
                      {fields.length > 0 && <div>Read by AI: {fields.map((f) => `${f.name.replace(/_/g, " ")} ${f.value}`).join(" · ")}</div>}
                      {(ex.warnings ?? []).map((w) => <div key={w} className="muted">{w}</div>)}
                    </div>
                  );
                })()}
              </div>
              {!d.deletedAt && user.role === "ADMIN" && <form action={delDoc}>{hidden}<input type="hidden" name="documentId" value={d.id} /><button className="danger">Delete</button></form>}
            </div>
          ))}
          {!lead.documents.length && <p className="muted">No documents.</p>}
          <p className="small muted">A document image does not prove authenticity, license validity, identity or hiring eligibility.</p>
        </Card>
        <Card title="Contact permission">
          {lead.permissions.map((p) => (
            <div key={p.id} className="small" style={{ marginBottom: 6 }}>
              <Badge v={p.scope} tone={p.revokedAt ? "bad" : "ok"} /> {p.source} · {fmt(p.grantedAt)} {p.isDemo && <Badge v="DEMO" tone="demo" />} {p.revokedAt && <span style={{ color: "var(--bad)" }}>revoked {fmt(p.revokedAt)}</span>}
              {p.evidence && <div className="muted">{p.evidence}</div>}
            </div>
          ))}
          {!lead.permissions.length && <p className="muted">No permission recorded. Automated calls stay blocked.</p>}
          {!lead.optedOutAt && (
            <form action={addPermission}>{hidden}
              <div className="row">
                <select name="scope"><option value="AI_CALL">AI calls</option><option value="SMS">Texts</option><option value="MANUAL_CALL">Manual calls</option></select>
                <input name="source" placeholder="Source (where/how)" required />
                <input name="grantedAt" type="datetime-local" required />
              </div>
              <label>Evidence</label><input name="evidence" style={{ width: "100%" }} />
              <div style={{ marginTop: 6 }}><button className="secondary">Record permission</button></div>
            </form>
          )}
        </Card>
      </div>

      <div className="grid two">
        <Card title="Tasks & handoffs">
          {lead.tasks.map((t) => (
            <div key={t.id} className="small" style={{ marginBottom: 6 }}><Badge v={t.status} /> <Badge v={t.type} tone="info" /> {t.title} · {t.assignedTo?.name ?? "unassigned"} {t.dueAt && `· due ${fmt(t.dueAt)}`}{t.notes && <div className="muted">{t.notes}</div>}</div>
          ))}
          {lead.handoffs.map((h) => (
            <details key={h.id} style={{ marginTop: 8 }}>
              <summary>Handoff: {h.reason.replace(/_/g, " ").toLowerCase()} · transfer <Badge v={h.transferStatus} /> · {fmt(h.createdAt)}</summary>
              <pre>{JSON.stringify(h.payload, null, 2)}</pre>
            </details>
          ))}
          {!lead.tasks.length && !lead.handoffs.length && <p className="muted">None.</p>}
        </Card>
        <Card title="Texts">
          {demoPhone && (
            <div className="alert warn small">Simulated driver phone (demo only): last text received: {demoPhone.body.split(/(https?:\/\/\S+)/).map((part, i) => /^https?:/.test(part) ? <a key={i} href={part} target="_blank" rel="noreferrer">{part}</a> : part)}</div>
          )}
          {lead.messages.map((m) => (
            <div key={m.id} className="small" style={{ marginBottom: 6 }}><Badge v={m.direction} tone="info" /> <Badge v={m.status} /> {m.isDemo && <Badge v="MOCK" tone="demo" />} {m.body}<div className="muted">{fmt(m.createdAt)}</div></div>
          ))}
          {!lead.messages.length && <p className="muted">No texts.</p>}
        </Card>
      </div>

      <Card title="Activity timeline">
        <ul className="timeline">
          {lead.events.map((e) => <li key={e.id}><span className="small muted">{fmt(e.createdAt)}</span> <Badge v={e.actorType} tone="info" /> {e.message}</li>)}
        </ul>
        {lead.assignments.length > 0 && <p className="small muted">Assignment history: {lead.assignments.map((a) => `${fmt(a.createdAt)} ${a.method.toLowerCase()}`).join(" · ")}</p>}
        <p className="small"><Link href="/leads">Back to leads</Link></p>
      </Card>
    </>
  );
}
