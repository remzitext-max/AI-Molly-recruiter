import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { isOwner, requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertAdmin, assertLeadAccess, leadScope } from "@/lib/rbac";
import { assignLead, transferLead } from "@/lib/assignment";
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
import { ConfirmButton } from "@/components/confirm-button";
import { flash } from "@/lib/flash";
import { HIRE_LABEL, HIRE_STAGES, setHireStage } from "@/lib/hiring";
import type { HireStage } from "@prisma/client";
import { RECRUITER_STATUSES, setRecruiterStatus, statusTone } from "@/lib/recruiter-status";
import { saveUploadedRecording } from "@/lib/recruiter-upload";
import { BASIC_FIELDS, PROFILE_FIELDS, loadDriverProfile, saveProfileEdits } from "@/lib/driver-profile";

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
  const to = String(fd.get("userId") || "") || null;
  // Any recruiter can hand a driver to a colleague; only an admin can leave it unassigned.
  if (to) {
    const r = await transferLead(id, to, u);
    await flash(r.changed ? `Lead transferred to ${r.to}` : `Already with ${r.to}`);
  } else {
    assertAdmin(u);
    await assignLead(id, null, "MANUAL", u.id);
    await flash("Lead unassigned");
  }
  revalidatePath(`/leads/${id}`);
}

async function editProfile(fd: FormData) {
  "use server";
  const id = String(fd.get("leadId"));
  const u = await guard(id);
  const keys = [...BASIC_FIELDS.map((f) => f.key), ...PROFILE_FIELDS.map((f) => f.key)];
  const changed = await saveProfileEdits(u, id, Object.fromEntries(keys.map((k) => [k, String(fd.get(k) ?? "")])));
  await flash(changed?.length ? `Profile saved: ${changed.join(", ")}` : "Nothing changed");
  revalidatePath(`/leads/${id}`);
  redirect(`/leads/${id}`);
}

async function uploadRecording(fd: FormData) {
  "use server";
  const id = String(fd.get("leadId"));
  const u = await guard(id);
  const f = fd.get("recording");
  const r = f instanceof File && f.size ? await saveUploadedRecording(u, id, { name: f.name, data: Buffer.from(await f.arrayBuffer()) }) : { error: "Choose a recording file" };
  if ("error" in r) await flash(r.error!, "error");
  else await flash("Recording uploaded. Crystal fills the profile from it in a minute or two");
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
  await flash("AI call scheduled");
  revalidatePath(`/leads/${id}`);
}

async function stopCalls(fd: FormData) {
  "use server";
  const id = String(fd.get("leadId"));
  const u = await guard(id);
  await stopAiCalls(id, { id: u.id, name: u.name });
  await flash("AI calls stopped for this lead");
  revalidatePath(`/leads/${id}`);
}

async function setHire(fd: FormData) {
  "use server";
  const id = String(fd.get("leadId"));
  const u = await guard(id);
  const stage = String(fd.get("hireStage")) as HireStage;
  const r = await setHireStage(id, stage, String(fd.get("hireNote") || ""), { id: u.id, name: u.name });
  await flash(r.changed ? `Hiring result saved: ${HIRE_LABEL[stage]}` : "Nothing changed");
  revalidatePath(`/leads/${id}`);
}

async function setStatus(fd: FormData) {
  "use server";
  const id = String(fd.get("leadId"));
  const u = await guard(id);
  const r = await setRecruiterStatus(id, String(fd.get("status")), { id: u.id, name: u.name });
  await flash(r.changed ? `Status saved: ${String(fd.get("status"))}` : "Nothing changed");
  revalidatePath(`/leads/${id}`);
}

async function optOut(fd: FormData) {
  "use server";
  const id = String(fd.get("leadId"));
  const u = await guard(id);
  await optOutLead(id, `Marked by ${u.name}`, { type: "USER", id: u.id });
  await flash("Driver opted out. No more calls or texts");
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
  await flash("Permission saved");
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
  await flash("Timezone saved");
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
  await flash("Your changes are saved");
  revalidatePath(`/leads/${id}`);
}

async function delDoc(fd: FormData) {
  "use server";
  const id = String(fd.get("leadId"));
  const u = await guard(id);
  assertAdmin(u);
  await deleteDocument(String(fd.get("documentId")), { type: "USER", id: u.id }, `deleted by ${u.name}`);
  await flash("Document deleted");
  revalidatePath(`/leads/${id}`);
}

async function sendLink(fd: FormData) {
  "use server";
  const id = String(fd.get("leadId"));
  const u = await guard(id);
  const r = await sendCdlLink(id, null, { verbalConsent: false });
  await recordEvent({ leadId: id, actorType: "USER", actorId: u.id, type: "CDL_LINK_REQUEST", message: r.sent ? "Recruiter sent CDL upload link" : `CDL link not sent: ${r.reason}` });
  await flash(r.sent ? "Text sent to the driver" : `Text not sent: ${r.reason}`, r.sent ? "ok" : "error");
  revalidatePath(`/leads/${id}`);
}

async function closeQuestion(fd: FormData) {
  "use server";
  const id = String(fd.get("leadId"));
  const u = await guard(id);
  await db.unansweredQuestion.update({ where: { id: String(fd.get("questionId")) }, data: { status: "ANSWERED", answer: String(fd.get("answer") || "") || null } });
  await recordEvent({ leadId: id, actorType: "USER", actorId: u.id, type: "QUESTION_ANSWERED", message: "Recruiter answered a driver question" });
  await flash("Question closed");
  revalidatePath(`/leads/${id}`);
}

async function clickToCall(fd: FormData) {
  "use server";
  const id = String(fd.get("leadId"));
  const u = await guard(id);
  const lead = await db.lead.findUniqueOrThrow({ where: { id } });
  const blocked = lead.optedOutAt ? "This driver opted out" : !u.transferPhoneE164 ? "Set your phone number on the Users page first" : config.mode === "live" && lead.isDemo ? "This is a demo record" : null;
  if (blocked) {
    await flash(blocked, "error");
    return revalidatePath(`/leads/${id}`);
  }
  const t = getAdapters().telephony;
  try {
    const r = await t.connectRecruiterToDriver(u.transferPhoneE164!, lead.phoneE164);
    await recordEvent({ leadId: id, actorType: "USER", actorId: u.id, type: "RECRUITER_CALL", message: `Click-to-call requested via ${t.key}${t.isMock ? " (MOCK, no call placed)" : ""}`, data: { ref: r.providerRef } });
    await flash("Calling your phone now. Pick up to be connected to the driver");
  } catch (e) {
    await recordEvent({ leadId: id, actorType: "USER", actorId: u.id, type: "RECRUITER_CALL_FAILED", message: `Click-to-call failed: ${(e as Error).message}` });
    await flash(`Call failed: ${(e as Error).message}`, "error");
  }
  revalidatePath(`/leads/${id}`);
}

export default async function LeadPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ edit?: string }> }) {
  const { id } = await params;
  const editing = (await searchParams).edit === "1";
  const user = await requireUser();
  const owner = await isOwner(user);
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
  const recruiters = await db.user.findMany({ where: { orgId: user.orgId, active: true }, orderBy: { name: "asc" } });
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
          {lead.recruiterStatus && <><span className={`badge ${statusTone(lead.recruiterStatus)}`}>{lead.recruiterStatus}</span> <span className="small muted">status</span></>}
          {lead.hireStage !== "NONE" && <><Badge v={HIRE_LABEL[lead.hireStage]} tone={lead.hireStage === "HIRED" ? "ok" : ["NOT_HIRED", "SAFETY_DECLINED"].includes(lead.hireStage) ? "bad" : "info"} /> <span className="small muted">hiring</span></>}
        </div>
      </div>
      {lead.optedOutAt && <div className="alert error">Opted out on {fmt(lead.optedOutAt)}. No automated calls or texts will be sent; the number is suppressed for future imports.</div>}
      {editing && <EditProfile user={user} leadId={lead.id} />}

      <div className="grid two">
        <Card title="Driver" right={<Link className="btn secondary" href={editing ? `/leads/${lead.id}` : `/leads/${lead.id}?edit=1`}>{editing ? "Cancel edit" : "Edit profile"}</Link>}>
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
            {owner && lead.fbCampaign && <tr><th>Facebook ad</th><td className="small">{lead.fbCampaign}{lead.fbAd ? ` · ${lead.fbAd}` : ""}{lead.fbForm ? <div className="muted">form: {lead.fbForm}</div> : null}</td></tr>}
            <tr><th>Sources</th><td className="small">{lead.sourceRecords.map((s) => <div key={s.id}>{s.sourceSystem}: {s.sourceRecordId} <span className="muted">sync: {s.syncStatus?.toLowerCase().replace(/_/g, " ") ?? "—"}</span></div>)}</td></tr>
          </tbody></table>
        </Card>
        <Card title="Actions">
          <form action={assign} className="inline">{hidden}
            <select name="userId" defaultValue={lead.assignedToId ?? ""} aria-label="Recruiter">{user.role === "ADMIN" || !lead.assignedToId ? <option value="">Unassigned</option> : null}{recruiters.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
            <button className="secondary">Transfer lead</button>
          </form>
          <h3>Call recording</h3>
          <form action={uploadRecording} className="inline">{hidden}
            <input type="file" name="recording" accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/ogg,.mp3,.wav,.m4a,.ogg" required />
            <button className="secondary">Upload recording</button>
          </form>
          <p className="small muted">Your own call with this driver (mp3, wav, m4a or ogg, up to 40 MB). Crystal turns it into text and fills the profile.</p>
          {!lead.optedOutAt && (
            <>
              {lead.ownDriver ? <p className="small muted">Your own driver: Crystal does not call them.</p> : <>
              <h3>Schedule AI call</h3>
              <form action={schedule} className="inline">{hidden}
                <input type="datetime-local" name="at" title="Leave empty for as soon as permitted" />
                {config.mode === "demo" && <select name="persona">{PERSONAS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select>}
                <button>Schedule</button>
              </form>
              <p className="small muted">Permission, contact hours, pause switches and attempt limits are checked again when the call is due.</p>
              </>}
              <h3>Recruiter actions</h3>
              <div className="row">
                <form action={sendLink}>{hidden}<button className="secondary">Text CDL / med card request</button></form>
                <form action={clickToCall}>{hidden}<button className="secondary">Call from my phone</button></form>
                <form action={stopCalls}>{hidden}<ConfirmButton className="secondary" title="Stop AI calls for this driver?" message="Crystal will not call this driver again. The lead stays on the site and you can still call or text them yourself." confirmLabel="Stop AI calls">Stop AI calls</ConfirmButton></form>
                <form action={optOut}>{hidden}<ConfirmButton className="danger" danger title="Opt this driver out?" message="The number is blocked for good: no AI calls, no texts, and future imports of this number are skipped. Use this only if the driver asked not to be contacted." confirmLabel="Yes, opt out">Opt out / stop contact</ConfirmButton></form>
                <form action={setStatus} className="inline">{hidden}
                  <select name="status" defaultValue={lead.recruiterStatus ?? ""} aria-label="Driver status" required>
                    <option value="" disabled>Status: not set</option>
                    {RECRUITER_STATUSES.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                  <button className="secondary">Set status</button>
                </form>
              </div>
              <p className="small muted">Any status except New and No answer stops Crystal&apos;s calls and texts for this driver. The lead sheet&apos;s Status column is copied here too.</p>
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

      <Card title="Hiring result" right={lead.hireStageAt ? <span className="small muted">updated {fmt(lead.hireStageAt)}{lead.hiredAt ? ` · hired ${fmt(lead.hiredAt)}` : ""}</span> : undefined}>
        <form action={setHire} className="inline">{hidden}
          <select name="hireStage" defaultValue={lead.hireStage}>{HIRE_STAGES.map((h) => <option key={h} value={h}>{HIRE_LABEL[h]}</option>)}</select>
          <input name="hireNote" defaultValue={lead.hireNote ?? ""} placeholder="Note (optional), e.g. orientation date or why not" size={40} maxLength={500} />
          <button>Save</button>
        </form>
        <p className="small muted" style={{ margin: "6px 0 0" }}>Set by the recruiter as the driver moves on; any status stops Crystal&apos;s calls. &ldquo;Hired&rdquo; counts on the dashboard (lead to hire, cost per hire) and posts to Telegram.</p>
      </Card>

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
              {c.isDemo && <Badge v="SIMULATED" tone="demo" />} {endedBy(c) && <strong className="small">{endedBy(c)}</strong>} {c.startedAt && c.endedAt && <span className="small muted">{Math.round((c.endedAt.getTime() - c.startedAt.getTime()) / 1000)} sec</span>}
              {ov(c.offerVersionId) && <span className="small muted">offer: {ov(c.offerVersionId)!.offer.name} v{ov(c.offerVersionId)!.version}{ov(c.offerVersionId)!.synthetic ? " (synthetic)" : ""}</span>}
            </div>
            {c.summary && <p>{c.summary}</p>}
            {c.errorMessage && <p className="small" style={{ color: "var(--bad)" }}>{c.errorMessage}</p>}
            {Array.isArray(c.transcript) && (
              <details><summary>Transcript ({(c.transcript as Turn[]).length} turns)</summary>
                <div className="transcript">
                  {(c.transcript as Turn[]).map((t, i) => <div key={i} className={`turn ${t.speaker}`}><span className="who">{t.speaker === "agent" ? "AI" : t.speaker === "driver" ? "Driver" : t.speaker.startsWith("speaker_") ? `Speaker ${t.speaker.slice(8)}` : "Call"}</span>{t.text}</div>)}
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
              {!d.deletedAt && user.role === "ADMIN" && <form action={delDoc}>{hidden}<input type="hidden" name="documentId" value={d.id} /><ConfirmButton className="danger" danger title="Delete this document?" message="The file is removed from storage and cannot be recovered." confirmLabel="Delete">Delete</ConfirmButton></form>}
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

/** The recruiter fills in or corrects the driver's profile (same fields as the popup and the PDF). */
async function EditProfile({ user, leadId }: { user: Awaited<ReturnType<typeof requireUser>>; leadId: string }) {
  const p = await loadDriverProfile(user, leadId);
  if (!p) return null;
  return (
    <Card title="Edit driver profile">
      <form action={editProfile} className="dp-edit">
        <input type="hidden" name="leadId" value={leadId} />
        <div className="dp-grid">
          {BASIC_FIELDS.map((f) => <label key={f.key}>{f.label}<input name={f.key} defaultValue={p.edit[f.key]} /></label>)}
          {PROFILE_FIELDS.filter((f) => f.section !== "employers").map((f) => <label key={f.key}>{f.label}<input name={f.key} defaultValue={p.edit[f.key]} /></label>)}
        </div>
        {PROFILE_FIELDS.filter((f) => f.section === "employers").map((f) => (
          <label key={f.key} className="dp-wide">{f.label}<textarea name={f.key} rows={4} defaultValue={p.edit[f.key]} placeholder={"Werner, 04/2024 - now, OTR\nSwift, 2022 - 03/2024, OTR"} /></label>
        ))}
        <p className="small muted">What the driver told Crystal is kept in the history; your values are shown in the profile and the PDF.</p>
        <div className="row"><button>Save profile</button><Link className="btn secondary" href={`/leads/${leadId}`}>Cancel</Link></div>
      </form>
    </Card>
  );
}
