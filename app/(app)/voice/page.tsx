import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { db } from "@/lib/db";
import { getAdapters } from "@/adapters/registry";
import { PREVIEW_SCRIPTS } from "@/lib/demo-data";
import { recordEvent } from "@/lib/activity";
import { Badge, Card, fmt } from "@/components/ui";
import { ChatConsole } from "./chat-console";
import { InspectForm } from "./inspect-form";
import { flash } from "@/lib/flash";

const PROFILE = "Molly Recruiting Assistant";

async function saveProfile(fd: FormData) {
  "use server";
  const u = await requireOwner();
  const g = (k: string) => String(fd.get(k) ?? "").trim() || null;
  const provider = g("provider") ?? "mock";
  const consentDate = g("consentDate") ? new Date(g("consentDate")!) : null;
  await db.voiceProfile.upsert({
    where: { name: PROFILE },
    create: { name: PROFILE, provider, providerVoiceId: g("providerVoiceId"), status: provider === "mock" ? "MOCK" : g("providerVoiceId") ? "READY" : "NOT_CREATED", isMock: provider === "mock", consentScope: g("consentScope"), consentDate, consentRecordedById: u.id, consentNotes: g("consentNotes"), verificationStatus: g("verificationStatus"), notes: g("notes") },
    update: { provider, providerVoiceId: g("providerVoiceId"), status: provider === "mock" ? "MOCK" : g("providerVoiceId") ? "READY" : "NOT_CREATED", isMock: provider === "mock", consentScope: g("consentScope"), consentDate, consentRecordedById: u.id, consentNotes: g("consentNotes"), verificationStatus: g("verificationStatus"), notes: g("notes") },
  });
  await recordEvent({ actorType: "USER", actorId: u.id, orgId: u.orgId, type: "VOICE_PROFILE", message: `Voice profile updated (provider ${provider})` });
  await flash("Your changes are saved");
  revalidatePath("/voice");
}

async function generatePreviews() {
  "use server";
  const u = await requireOwner();
  const profile = await db.voiceProfile.findUniqueOrThrow({ where: { name: PROFILE } });
  const synth = getAdapters().synth;
  for (const s of PREVIEW_SCRIPTS) {
    try {
      const r = await synth.synthesize(s.text, profile.providerVoiceId);
      const key = `voice-previews/${profile.id}/${crypto.randomUUID()}.wav`;
      await getAdapters().storage.put(key, r.audio, r.mimeType);
      await db.voicePreview.create({ data: { voiceProfileId: profile.id, kind: s.kind, text: s.text, audioKey: key, synthetic: true, latencyMs: r.latencyMs } });
    } catch (e) {
      await db.voicePreview.create({ data: { voiceProfileId: profile.id, kind: s.kind, text: s.text, synthetic: true, error: (e as Error).message.slice(0, 300) } });
    }
  }
  await recordEvent({ actorType: "USER", actorId: u.id, orgId: u.orgId, type: "VOICE_PREVIEW", message: `Generated private voice previews with ${synth.key}${synth.isMock ? " (placeholder tone, not Molly)" : ""}` });
  await flash("Voice previews generated");
  revalidatePath("/voice");
}

export default async function VoicePage() {
  await requireOwner();
  const profile = await db.voiceProfile.findUnique({ where: { name: PROFILE }, include: { previews: { orderBy: { createdAt: "desc" }, take: 18 } } });
  const synth = getAdapters().synth;
  return (
    <>
      <h1>Voice agent</h1>
      <div className="alert warn">
        Status: <strong>{profile?.status ?? "NOT_CREATED"}</strong>. No voice has been cloned yet. HeyGen voices cannot be used for live phone calls (they stay inside HeyGen and are not supported by phone voice-agent providers). The documented path is cloning inside the voice-agent provider (Retell with Cartesia or ElevenLabs) after Molly completes the provider’s own verification. See docs/VOICE.md.
      </div>
      <div className="grid two">
        <Card title="Voice profile (server-side record)">
          <form action={saveProfile}>
            <label>Provider</label>
            <select name="provider" defaultValue={profile?.provider ?? "mock"}>
              <option value="mock">Mock (placeholder, not Molly)</option>
              <option value="retell-cartesia">Retell + Cartesia clone</option>
              <option value="retell-elevenlabs">Retell + ElevenLabs</option>
              <option value="heygen">HeyGen (previews only)</option>
            </select>
            <label>Provider voice ID (returned by the provider, never typed from guesswork)</label>
            <input name="providerVoiceId" defaultValue={profile?.providerVoiceId ?? ""} style={{ width: "100%" }} />
            <label>Consent scope (as provided by the owner)</label>
            <textarea name="consentScope" rows={2} defaultValue={profile?.consentScope ?? ""} placeholder="e.g. AI recruiting assistant phone calls for Company X, revocable by Molly at any time" />
            <label>Consent date</label>
            <input type="date" name="consentDate" defaultValue={profile?.consentDate?.toISOString().slice(0, 10) ?? ""} />
            <label>Where the consent is documented</label>
            <input name="consentNotes" defaultValue={profile?.consentNotes ?? ""} style={{ width: "100%" }} placeholder="e.g. signed form stored in HR system" />
            <label>Provider speaker verification status</label>
            <input name="verificationStatus" defaultValue={profile?.verificationStatus ?? ""} placeholder="e.g. completed by Molly on 2026-11-02" />
            <label>Notes</label><textarea name="notes" rows={2} defaultValue={profile?.notes ?? ""} />
            <div style={{ marginTop: 8 }}><button>Save</button></div>
          </form>
        </Card>
        <Card title="Check Molly’s recording (local only)">
          <p className="small muted">Checks sample rate, length, loudness, clipping and silence. Nothing is uploaded to any provider. Use only Molly’s own voice; never driver calls or other speakers.</p>
          <InspectForm />
        </Card>
      </div>
      <Card title="Private previews" right={<form action={generatePreviews}><button className="secondary">Generate previews ({synth.key})</button></form>}>
        <p className="small muted">Uses clearly labelled synthetic offer facts. {synth.isMock ? "The current synthesizer is a MOCK tone generator: it is not Molly’s voice." : ""} Molly and the owner judge similarity and naturalness; this tool makes no claim that the voice is indistinguishable from a human.</p>
        <table><thead><tr><th>Sample</th><th>Text</th><th>Audio</th><th>Synthesis time</th></tr></thead><tbody>
          {profile?.previews.map((p) => (
            <tr key={p.id}><td>{p.kind}<div className="small muted">{fmt(p.createdAt)}</div></td><td className="small">{p.text}</td>
              <td>{p.audioKey ? <audio controls preload="none" src={`/api/voice-previews/${p.id}`} /> : <span className="small" style={{ color: "var(--bad)" }}>{p.error}</span>}</td>
              <td className="small">{p.latencyMs != null ? `${p.latencyMs} ms (full file, not streaming)` : "—"}</td></tr>
          ))}
        </tbody></table>
      </Card>
      <Card title="Try the conversation (text sandbox)">
        <p className="small muted">You play the driver. Uses the active offer’s approved facts and the same rules as calls. Nothing is saved and no one is contacted. Optional speech uses your browser’s built-in voice, not Molly’s.</p>
        <ChatConsole />
      </Card>
    </>
  );
}
