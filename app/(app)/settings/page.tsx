import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettings, validateOpening } from "@/lib/settings";
import { config } from "@/lib/config";
import { recordEvent } from "@/lib/activity";
import { integrationStatuses } from "@/adapters/registry";
import { DEFAULT_SLOTS, type SlotSpec } from "@/lib/conversation/brain";
import { Badge, Card, PageHead, fmt } from "@/components/ui";
import { fitRulesFrom, type FitRules } from "@/lib/fit-score";
import { ConfirmButton } from "@/components/confirm-button";
import { flash } from "@/lib/flash";

async function togglePause(fd: FormData) {
  "use server";
  const u = await requireOwner();
  const on = fd.get("on") === "1";
  await db.systemSetting.update({ where: { id: "global" }, data: { globalPause: on } });
  await recordEvent({ actorType: "USER", actorId: u.id, orgId: u.orgId, type: "GLOBAL_PAUSE", message: `Global pause ${on ? "ON" : "OFF"}` });
  await flash("Global pause updated");
  revalidatePath("/", "layout");
}

async function saveCampaign(fd: FormData) {
  "use server";
  const u = await requireOwner();
  const id = String(fd.get("id"));
  const time = (v: FormDataEntryValue | null) => (/^\d{2}:\d{2}$/.test(String(v)) ? String(v) : "09:00");
  const days = fd.getAll("days").map(String).filter((d) => /^[1-7]$/.test(d)).join(",") || "1,2,3,4,5";
  await db.campaign.update({
    where: { id, orgId: u.orgId } as never,
    data: {
      paused: fd.get("paused") === "on", contactWindowStart: time(fd.get("start")), contactWindowEnd: time(fd.get("end")), contactDays: days,
      hotCallMinutes: Math.min(120, Math.max(0, Math.round(Number(fd.get("hotCallMinutes")) || 0))),
      reengageAfterDays: Math.min(365, Math.max(0, Math.round(Number(fd.get("reengageAfterDays")) || 0))),
      recallMinDays: Math.min(365, Math.max(0, Math.round(Number(fd.get("recallMinDays")) || 0))),
      recallMaxDays: Math.min(365, Math.max(1, Math.round(Number(fd.get("recallMaxDays")) || 60))),
      recallPerDay: Math.min(200, Math.max(1, Math.round(Number(fd.get("recallPerDay")) || 25))),
      maxAttempts: Math.min(10, Math.max(1, Number(fd.get("maxAttempts")) || 3)), retryDelayMinutes: Math.min(10080, Math.max(1, Number(fd.get("retryDelay")) || 240)),
      assignmentMode: fd.get("assignmentMode") === "MANUAL" ? "MANUAL" : "ROUND_ROBIN", offerId: String(fd.get("offerId") || "") || null,
    },
  });
  await recordEvent({ actorType: "USER", actorId: u.id, orgId: u.orgId, type: "CAMPAIGN", message: `Campaign settings updated${fd.get("paused") === "on" ? " (paused)" : ""}` });
  await flash("Your changes are saved");
  revalidatePath("/settings");
}

async function savePolicy(fd: FormData) {
  "use server";
  const u = await requireOwner();
  const openingError = validateOpening(String(fd.get("aiDisclosure") || ""));
  if (openingError) redirect(`/settings?error=${encodeURIComponent(openingError)}`);
  const n = (k: string, d: number, min: number, max: number) => Math.min(max, Math.max(min, Number(fd.get(k)) || d));
  await db.systemSetting.update({
    where: { id: "global" },
    data: {
      requireCallPermission: fd.get("requireCallPermission") === "on", requireSmsPermission: fd.get("requireSmsPermission") === "on",
      allowVerbalSmsConsent: fd.get("allowVerbalSmsConsent") === "on", cdlBySms: fd.get("cdlBySms") === "on", recordConsentEnabled: fd.get("recordConsentEnabled") === "on",
      recordConsentText: String(fd.get("recordConsentText") || "").trim().slice(0, 2000) || undefined, recordingEnabled: fd.get("recordingEnabled") === "on",
      recordingNotice: String(fd.get("recordingNotice") || "").slice(0, 300), aiDisclosure: String(fd.get("aiDisclosure") || "").slice(0, 400),
      voicemailMessage: String(fd.get("voicemailMessage") || "").slice(0, 400), documentRetentionDays: n("retention", 30, 1, 3650),
      uploadLinkTtlMinutes: n("ttl", 60, 5, 1440), maxUploadBytes: n("maxMb", 10, 1, 25) * 1048576,
      missedCallSms: fd.get("missedCallSms") === "on", missedCallSmsText: String(fd.get("missedCallSmsText") || "").trim().slice(0, 480) || undefined,
      missedCallSmsOffer: String(fd.get("missedCallSmsOffer") || "").replace(/\r\n/g, "\n").trim().slice(0, 1000),
      recruiterTelegram: String(fd.get("recruiterTelegram") || "").replace(/\r\n/g, "\n").trim().slice(0, 2000),
      recruiterTransfer: String(fd.get("recruiterTransfer") || "").replace(/\r\n/g, "\n").trim().slice(0, 2000),
    },
  });
  await recordEvent({ actorType: "USER", actorId: u.id, orgId: u.orgId, type: "POLICY", message: "Contact policy settings updated" });
  await flash("Your changes are saved");
  revalidatePath("/settings");
}

async function saveFitRules(fd: FormData) {
  "use server";
  const u = await requireOwner();
  const rules: FitRules = fitRulesFrom({
    minSoloMonths: Number(fd.get("minSoloMonths")), minTeamMonths: Number(fd.get("minTeamMonths")),
    sapKnockout: fd.get("sapKnockout") === "on", requireClassA: fd.get("requireClassA") === "on",
  });
  await db.systemSetting.update({ where: { id: "global" }, data: { fitRules: rules as never } });
  await recordEvent({ actorType: "USER", actorId: u.id, orgId: u.orgId, type: "FIT_RULES", message: "Fit score rules updated" });
  await flash("Your changes are saved");
  revalidatePath("/settings");
}

async function confirmPolicy(fd: FormData) {
  "use server";
  const u = await requireOwner();
  const notes = String(fd.get("notes") || "").trim();
  if (notes.length < 20) redirect("/settings?error=Describe the reviewed contact policy (who approved it and what it covers)");
  await db.systemSetting.update({ where: { id: "global" }, data: { contactPolicyConfirmedAt: new Date(), contactPolicyConfirmedById: u.id, contactPolicyNotes: notes } });
  await recordEvent({ actorType: "USER", actorId: u.id, orgId: u.orgId, type: "POLICY_CONFIRMED", message: "Contact policy confirmed for production" });
  await flash("Contact policy confirmed");
  revalidatePath("/settings");
}

async function setLive(fd: FormData) {
  "use server";
  const u = await requireOwner();
  const on = fd.get("on") === "1";
  const s = await getSettings();
  if (on) {
    if (config.mode !== "live") redirect("/settings?error=Set APP_MODE=live on the server first");
    if (!s.contactPolicyConfirmedAt) redirect("/settings?error=Confirm the contact policy first");
    const st = integrationStatuses();
    const voice = st.find((i) => i.kind === "voice_agent");
    if (voice?.state !== "configured") redirect("/settings?error=Voice-agent provider is not configured");
  }
  await db.systemSetting.update({ where: { id: "global" }, data: { liveContactEnabled: on } });
  await recordEvent({ actorType: "USER", actorId: u.id, orgId: u.orgId, type: "LIVE_CONTACT", message: `Production contact ${on ? "ENABLED" : "DISABLED"}` });
  await flash("Live contact updated");
  revalidatePath("/", "layout");
}

async function saveScreening(fd: FormData) {
  "use server";
  const u = await requireOwner();
  const cfg: SlotSpec[] = DEFAULT_SLOTS.map((s) => ({ ...s, enabled: fd.get(`en_${s.key}`) === "on", essential: fd.get(`es_${s.key}`) === "on", prompt: String(fd.get(`p_${s.key}`) || s.prompt).slice(0, 200) }));
  await db.systemSetting.update({ where: { id: "global" }, data: { screeningConfig: cfg as never } });
  await recordEvent({ actorType: "USER", actorId: u.id, orgId: u.orgId, type: "SCREENING_CONFIG", message: "Screening questions updated" });
  await flash("Your changes are saved");
  revalidatePath("/settings");
}

export default async function Settings({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const u = await requireOwner();
  const sp = await searchParams;
  const s = await getSettings();
  const [campaigns, offers] = await Promise.all([db.campaign.findMany({ where: { orgId: u.orgId } }), db.offer.findMany({ where: { orgId: u.orgId } })]);
  const slots = (s.screeningConfig as SlotSpec[] | null) ?? DEFAULT_SLOTS;
  const fit = fitRulesFrom(s.fitRules);
  return (
    <>
      <PageHead title="Settings" sub="Calling hours, campaigns, contact policy, Crystal’s screening questions and recording." />
      {sp.error && <div className="alert error">{sp.error}</div>}
      <div className="grid two">
        <Card title="Global pause">
          <p>{s.globalPause ? <Badge v="PAUSED" tone="bad" /> : <Badge v="RUNNING" tone="ok" />} Stops every automated call and text immediately; queued work waits.</p>
          <form action={togglePause}><input type="hidden" name="on" value={s.globalPause ? "0" : "1"} /><ConfirmButton className={s.globalPause ? "" : "danger"} danger={!s.globalPause} title={s.globalPause ? "Resume all outreach?" : "Pause all outreach?"} message={s.globalPause ? "Crystal starts calling and texting leads again." : "No AI calls or texts will go out until you resume."} confirmLabel={s.globalPause ? "Resume" : "Pause everything"}>{s.globalPause ? "Resume outreach" : "Pause all outreach"}</ConfirmButton></form>
        </Card>
        <Card title="Production contact">
          <p>Server mode: <strong>{config.mode.toUpperCase()}</strong> · switch: {s.liveContactEnabled ? <Badge v="ENABLED" tone="bad" /> : <Badge v="DISABLED" tone="ok" />}</p>
          <p className="small muted">Real calls/texts need: APP_MODE=live, configured provider credentials, a confirmed contact policy, a published non-synthetic offer, and this switch.</p>
          <p className="small">Policy confirmed: {s.contactPolicyConfirmedAt ? `${fmt(s.contactPolicyConfirmedAt)}: ${s.contactPolicyNotes}` : "not yet"}</p>
          <form action={confirmPolicy}><label>Contact policy review notes (who approved, which consent language, which states)</label><textarea name="notes" rows={2} /><button className="secondary">Confirm contact policy</button></form>
          <form action={setLive} style={{ marginTop: 8 }}><input type="hidden" name="on" value={s.liveContactEnabled ? "0" : "1"} /><ConfirmButton className={s.liveContactEnabled ? "" : "danger"} danger={!s.liveContactEnabled} title={s.liveContactEnabled ? "Turn off real calls and texts?" : "Turn on real calls and texts?"} message={s.liveContactEnabled ? "Crystal stops reaching real drivers until you turn it back on." : "Crystal will call and text real drivers."} confirmLabel={s.liveContactEnabled ? "Turn off" : "Turn on"}>{s.liveContactEnabled ? "Disable production contact" : "Enable production contact"}</ConfirmButton></form>
        </Card>
      </div>

      <Card title="Campaigns">
        {campaigns.map((c) => (
          <form key={c.id} action={saveCampaign} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 10, marginBottom: 10 }}>
            <input type="hidden" name="id" value={c.id} />
            <div className="row"><strong>{c.name}</strong> {c.isDemo && <Badge v="DEMO" tone="demo" />} <label style={{ margin: 0 }}><input type="checkbox" name="paused" defaultChecked={c.paused} /> paused</label></div>
            <div className="row">
              <span className="small">Driver-local hours</span><input type="time" name="start" defaultValue={c.contactWindowStart} /> – <input type="time" name="end" defaultValue={c.contactWindowEnd} />
              {[1, 2, 3, 4, 5, 6, 7].map((d) => <label key={d} style={{ margin: 0 }}><input type="checkbox" name="days" value={d} defaultChecked={c.contactDays.split(",").includes(String(d))} />{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d - 1]}</label>)}
            </div>
            <div className="row">
              <span className="small">Call a new applicant right away at any hour if they applied within</span><input type="number" name="hotCallMinutes" defaultValue={c.hotCallMinutes} min={0} max={120} style={{ width: 60 }} /><span className="small">min (0 = off; retries keep to the hours above)</span>
            </div>
            <div className="row">
              <span className="small">Call unreached and not-interested leads one more time</span><input type="number" name="reengageAfterDays" defaultValue={c.reengageAfterDays} min={0} max={365} style={{ width: 60 }} /><span className="small">days after their last call (0 = off; once per lead, up to 2 calls; never for opted-out or stopped leads)</span>
            </div>
            <div className="row">
              <span className="small">Call drivers marked &quot;No answer&quot; in the recruiters&apos; sheet tabs who applied</span><input type="number" name="recallMinDays" defaultValue={c.recallMinDays} min={0} max={365} style={{ width: 60 }} />
              <span className="small">to</span><input type="number" name="recallMaxDays" defaultValue={c.recallMaxDays} min={1} max={365} style={{ width: 60 }} />
              <span className="small">days ago, at most</span><input type="number" name="recallPerDay" defaultValue={c.recallPerDay} min={1} max={200} style={{ width: 60 }} />
              <span className="small">new per day (0 = off; up to 2 calls each; skipped if a recruiter has changed the status)</span>
            </div>
            <div className="row">
              <span className="small">Max AI attempts</span><input type="number" name="maxAttempts" defaultValue={c.maxAttempts} min={1} max={10} style={{ width: 60 }} />
              <span className="small">Retry after (min)</span><input type="number" name="retryDelay" defaultValue={c.retryDelayMinutes} style={{ width: 80 }} />
              <select name="assignmentMode" defaultValue={c.assignmentMode}><option value="ROUND_ROBIN">Round-robin assignment</option><option value="MANUAL">Manual assignment</option></select>
              <select name="offerId" defaultValue={c.offerId ?? ""}><option value="">No offer</option>{offers.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
              <button className="secondary">Save</button>
            </div>
          </form>
        ))}
      </Card>

      <Card title="Contact rules, disclosures and documents">
        <form action={savePolicy}>
          <label><input type="checkbox" name="requireCallPermission" defaultChecked={s.requireCallPermission} /> Require recorded permission before automated AI calls</label>
          <label><input type="checkbox" name="requireSmsPermission" defaultChecked={s.requireSmsPermission} /> Require recorded permission before texts</label>
          <label><input type="checkbox" name="allowVerbalSmsConsent" defaultChecked={s.allowVerbalSmsConsent} /> Accept the driver’s verbal “yes” on the call for the CDL-link text (recorded with call ID)</label>
          <label><input type="checkbox" name="cdlBySms" defaultChecked={s.cdlBySms} /> AI texts interested drivers a CDL upload link (needs a registered SMS number). Off: the recruiter collects the CDL.</label>
          <label><input type="checkbox" name="recordConsentEnabled" defaultChecked={s.recordConsentEnabled} /> Upload page asks the driver to sign a driving record check authorization (typed name)</label>
          <label>Record check authorization text ({"{company}"} = company name; best to paste your company’s own wording)</label><textarea name="recordConsentText" rows={3} defaultValue={s.recordConsentText} />
          <label><input type="checkbox" name="recordingEnabled" defaultChecked={s.recordingEnabled} /> Calls are recorded (the notice below is spoken at the start)</label>
          <label>Recording notice</label><input name="recordingNotice" defaultValue={s.recordingNotice} style={{ width: "100%" }} />
          <label>Call opening (spoken first; must include {"{company}"}; may not claim to be a person. If a driver asks, the AI always says it is an AI.)</label><textarea name="aiDisclosure" rows={2} defaultValue={s.aiDisclosure} />
          <label><input type="checkbox" name="missedCallSms" defaultChecked={s.missedCallSms} /> Text the driver once when the AI call is not answered, from the recruiter&apos;s own number (RINGCENTRAL_TAB_SENDERS); replies show up as a task and in Telegram</label>
          <label>Missed-call text ({"{company}"}, {"{name}"} = driver’s full name, {"{first}"} = first name, {"{position}"} = solo driver / team driver, {"{persona}"} = {config.agentPersona.name})</label><textarea name="missedCallSmsText" rows={7} defaultValue={s.missedCallSmsText} />
          <label>Second text right after it, e.g. the offer (empty = none; up to 1000 characters; plain dashes keep it cheaper than • bullets)</label><textarea name="missedCallSmsOffer" rows={12} defaultValue={s.missedCallSmsOffer} />
          <label>Telegram: recruiter of each sheet tab, tagged on that tab&apos;s driver cards (one per line, e.g. Molly = @molly_tbt; a tab with no @username shows &quot;Before processed by Molly&quot;)</label><textarea name="recruiterTelegram" rows={6} defaultValue={s.recruiterTelegram} />
          <label>Live transfer: phone of each sheet tab&apos;s recruiter (one per line, e.g. Dennis = +18158461661). That tab&apos;s drivers are connected to this number; everyone else goes to the manager on Users. After a change, re-run telnyx-setup on the server.</label><textarea name="recruiterTransfer" rows={3} defaultValue={s.recruiterTransfer} />
          <label>Voicemail message</label><textarea name="voicemailMessage" rows={2} defaultValue={s.voicemailMessage} />
          <div className="row">
            <span className="small">Keep CDL files</span><input type="number" name="retention" defaultValue={s.documentRetentionDays} style={{ width: 70 }} /><span className="small">days</span>
            <span className="small">Upload link valid</span><input type="number" name="ttl" defaultValue={s.uploadLinkTtlMinutes} style={{ width: 70 }} /><span className="small">min</span>
            <span className="small">Max file</span><input type="number" name="maxMb" defaultValue={Math.round(s.maxUploadBytes / 1048576)} style={{ width: 60 }} /><span className="small">MB</span>
          </div>
          <div style={{ marginTop: 8 }}><button>Save</button></div>
        </form>
      </Card>

      <Card title="Fit score rules">
        <p className="small muted">Each lead gets a 0-100 score from the driver’s own answers. It is a guide for recruiters only: it is never said to the driver and does not decide hiring.</p>
        <form action={saveFitRules}>
          <div className="row">
            <span className="small">Minimum experience, solo</span><input type="number" name="minSoloMonths" defaultValue={fit.minSoloMonths} min={0} max={240} style={{ width: 70 }} /><span className="small">months</span>
            <span className="small">team</span><input type="number" name="minTeamMonths" defaultValue={fit.minTeamMonths} min={0} max={240} style={{ width: 70 }} /><span className="small">months</span>
          </div>
          <label><input type="checkbox" name="sapKnockout" defaultChecked={fit.sapKnockout} /> SAP history means not a fit</label>
          <label><input type="checkbox" name="requireClassA" defaultChecked={fit.requireClassA} /> Only Class A CDL fits</label>
          <p className="small muted">Also lowers the score: at-fault accidents, English rated fair or poor, not interested, and unanswered questions.</p>
          <div style={{ marginTop: 8 }}><button>Save</button></div>
        </form>
      </Card>

      <Card title="Screening questions">
        <p className="small muted">“Essential” answers are required (with interest and a received CDL) before the normal handoff. SSN, payment and medical questions are not allowed.</p>
        <form action={saveScreening}>
          <table><thead><tr><th>Field</th><th>Ask</th><th>Essential</th><th>Question wording</th></tr></thead><tbody>
            {DEFAULT_SLOTS.map((d) => { const c = slots.find((x) => x.key === d.key) ?? d; return (
              <tr key={d.key}><td>{d.key.replace(/_/g, " ")}</td><td><input type="checkbox" name={`en_${d.key}`} defaultChecked={c.enabled} /></td><td><input type="checkbox" name={`es_${d.key}`} defaultChecked={c.essential} /></td><td><input name={`p_${d.key}`} defaultValue={c.prompt} style={{ width: "100%" }} /></td></tr>
            ); })}
          </tbody></table>
          <div style={{ marginTop: 8 }}><button>Save</button></div>
        </form>
      </Card>
    </>
  );
}
