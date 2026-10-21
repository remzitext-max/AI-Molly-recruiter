import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettings, validateOpening } from "@/lib/settings";
import { config } from "@/lib/config";
import { recordEvent } from "@/lib/activity";
import { integrationStatuses } from "@/adapters/registry";
import { DEFAULT_SLOTS, type SlotSpec } from "@/lib/conversation/brain";
import { Badge, Card, PageHead, fmt } from "@/components/ui";

async function togglePause(fd: FormData) {
  "use server";
  const u = await requireAdmin();
  const on = fd.get("on") === "1";
  await db.systemSetting.update({ where: { id: "global" }, data: { globalPause: on } });
  await recordEvent({ actorType: "USER", actorId: u.id, orgId: u.orgId, type: "GLOBAL_PAUSE", message: `Global pause ${on ? "ON" : "OFF"}` });
  revalidatePath("/", "layout");
}

async function saveCampaign(fd: FormData) {
  "use server";
  const u = await requireAdmin();
  const id = String(fd.get("id"));
  const time = (v: FormDataEntryValue | null) => (/^\d{2}:\d{2}$/.test(String(v)) ? String(v) : "09:00");
  const days = fd.getAll("days").map(String).filter((d) => /^[1-7]$/.test(d)).join(",") || "1,2,3,4,5";
  await db.campaign.update({
    where: { id, orgId: u.orgId } as never,
    data: {
      paused: fd.get("paused") === "on", contactWindowStart: time(fd.get("start")), contactWindowEnd: time(fd.get("end")), contactDays: days,
      hotCallMinutes: Math.min(120, Math.max(0, Math.round(Number(fd.get("hotCallMinutes")) || 0))),
      maxAttempts: Math.min(10, Math.max(1, Number(fd.get("maxAttempts")) || 3)), retryDelayMinutes: Math.min(10080, Math.max(1, Number(fd.get("retryDelay")) || 240)),
      assignmentMode: fd.get("assignmentMode") === "MANUAL" ? "MANUAL" : "ROUND_ROBIN", offerId: String(fd.get("offerId") || "") || null,
    },
  });
  await recordEvent({ actorType: "USER", actorId: u.id, orgId: u.orgId, type: "CAMPAIGN", message: `Campaign settings updated${fd.get("paused") === "on" ? " (paused)" : ""}` });
  revalidatePath("/settings");
}

async function savePolicy(fd: FormData) {
  "use server";
  const u = await requireAdmin();
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
    },
  });
  await recordEvent({ actorType: "USER", actorId: u.id, orgId: u.orgId, type: "POLICY", message: "Contact policy settings updated" });
  revalidatePath("/settings");
}

async function confirmPolicy(fd: FormData) {
  "use server";
  const u = await requireAdmin();
  const notes = String(fd.get("notes") || "").trim();
  if (notes.length < 20) redirect("/settings?error=Describe the reviewed contact policy (who approved it and what it covers)");
  await db.systemSetting.update({ where: { id: "global" }, data: { contactPolicyConfirmedAt: new Date(), contactPolicyConfirmedById: u.id, contactPolicyNotes: notes } });
  await recordEvent({ actorType: "USER", actorId: u.id, orgId: u.orgId, type: "POLICY_CONFIRMED", message: "Contact policy confirmed for production" });
  revalidatePath("/settings");
}

async function setLive(fd: FormData) {
  "use server";
  const u = await requireAdmin();
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
  revalidatePath("/", "layout");
}

async function saveScreening(fd: FormData) {
  "use server";
  const u = await requireAdmin();
  const cfg: SlotSpec[] = DEFAULT_SLOTS.map((s) => ({ ...s, enabled: fd.get(`en_${s.key}`) === "on", essential: fd.get(`es_${s.key}`) === "on", prompt: String(fd.get(`p_${s.key}`) || s.prompt).slice(0, 200) }));
  await db.systemSetting.update({ where: { id: "global" }, data: { screeningConfig: cfg as never } });
  await recordEvent({ actorType: "USER", actorId: u.id, orgId: u.orgId, type: "SCREENING_CONFIG", message: "Screening questions updated" });
  revalidatePath("/settings");
}

export default async function Settings({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const u = await requireAdmin();
  const sp = await searchParams;
  const s = await getSettings();
  const [campaigns, offers] = await Promise.all([db.campaign.findMany({ where: { orgId: u.orgId } }), db.offer.findMany({ where: { orgId: u.orgId } })]);
  const slots = (s.screeningConfig as SlotSpec[] | null) ?? DEFAULT_SLOTS;
  return (
    <>
      <PageHead title="Settings" sub="Calling hours, campaigns, contact policy, Crystal’s screening questions and recording." />
      {sp.error && <div className="alert error">{sp.error}</div>}
      <div className="grid two">
        <Card title="Global pause">
          <p>{s.globalPause ? <Badge v="PAUSED" tone="bad" /> : <Badge v="RUNNING" tone="ok" />} Stops every automated call and text immediately; queued work waits.</p>
          <form action={togglePause}><input type="hidden" name="on" value={s.globalPause ? "0" : "1"} /><button className={s.globalPause ? "" : "danger"}>{s.globalPause ? "Resume outreach" : "Pause all outreach"}</button></form>
        </Card>
        <Card title="Production contact">
          <p>Server mode: <strong>{config.mode.toUpperCase()}</strong> · switch: {s.liveContactEnabled ? <Badge v="ENABLED" tone="bad" /> : <Badge v="DISABLED" tone="ok" />}</p>
          <p className="small muted">Real calls/texts need: APP_MODE=live, configured provider credentials, a confirmed contact policy, a published non-synthetic offer, and this switch.</p>
          <p className="small">Policy confirmed: {s.contactPolicyConfirmedAt ? `${fmt(s.contactPolicyConfirmedAt)}: ${s.contactPolicyNotes}` : "not yet"}</p>
          <form action={confirmPolicy}><label>Contact policy review notes (who approved, which consent language, which states)</label><textarea name="notes" rows={2} /><button className="secondary">Confirm contact policy</button></form>
          <form action={setLive} style={{ marginTop: 8 }}><input type="hidden" name="on" value={s.liveContactEnabled ? "0" : "1"} /><button className={s.liveContactEnabled ? "" : "danger"}>{s.liveContactEnabled ? "Disable production contact" : "Enable production contact"}</button></form>
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
          <label>Voicemail message</label><textarea name="voicemailMessage" rows={2} defaultValue={s.voicemailMessage} />
          <div className="row">
            <span className="small">Keep CDL files</span><input type="number" name="retention" defaultValue={s.documentRetentionDays} style={{ width: 70 }} /><span className="small">days</span>
            <span className="small">Upload link valid</span><input type="number" name="ttl" defaultValue={s.uploadLinkTtlMinutes} style={{ width: 70 }} /><span className="small">min</span>
            <span className="small">Max file</span><input type="number" name="maxMb" defaultValue={Math.round(s.maxUploadBytes / 1048576)} style={{ width: 60 }} /><span className="small">MB</span>
          </div>
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
