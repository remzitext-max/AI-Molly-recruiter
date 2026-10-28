// "Create form": a recruiter adds their own driver (someone they called themselves,
// not a Facebook lead) and uploads the call recording. The recording is turned into
// text with Telnyx speech-to-text and the profile is filled from it the same way as
// after Crystal's calls. Crystal never calls these drivers.
import type { Prisma, User } from "@prisma/client";
import { db } from "./db";
import { config } from "./config";
import { ingestLead } from "./leads";
import { assignLead } from "./assignment";
import { recordEvent } from "./activity";
import { randomToken } from "./crypto";
import { enqueue } from "./jobs/queue";
import { audioType } from "./recordings";
import { fillScreeningFromTranscript } from "./transcript-extract";
import { getAdapters } from "../adapters/registry";
import { providerFetch } from "../adapters/live/http";
import { redactText } from "./redact";

/** CallAttempt.provider of a recording a recruiter uploaded (not one of Crystal's calls). */
export const UPLOAD_PROVIDER = "recruiter-upload";
export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

export async function createOwnDriver(user: User, v: { phone: string; firstName?: string; lastName?: string; state?: string; drivingType?: string }) {
  const campaign = (await db.campaign.findFirst({ where: { orgId: user.orgId, isDemo: false }, orderBy: { createdAt: "asc" } }))
    ?? (await db.campaign.findFirst({ where: { orgId: user.orgId }, orderBy: { createdAt: "asc" } }));
  if (!campaign) return { error: "No campaign yet" };
  let r;
  try {
    r = await ingestLead(
      { sourceSystem: "RECRUITER", sourceRecordId: `recruiter-${randomToken(9)}`, firstName: v.firstName, lastName: v.lastName, phone: v.phone, state: v.state,
        raw: { createdBy: user.name, ...(v.drivingType ? { position: v.drivingType } : {}) } },
      { orgId: user.orgId, campaignId: campaign.id, isDemo: config.mode === "demo" || campaign.isDemo, actorId: user.id, scheduleOutreach: false },
    );
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (r.result === "invalid") return { error: r.error };
  if (r.result !== "created") return { leadId: r.leadId, existed: true };
  // HANDED_OFF keeps every automatic call and follow-up away from this driver.
  await db.lead.update({ where: { id: r.leadId }, data: { ownDriver: true, createdById: user.id, pipelineStatus: "HANDED_OFF", queueReason: null } });
  await assignLead(r.leadId, user.id, "MANUAL", user.id);
  if (v.drivingType) {
    await db.screeningField.create({ data: { leadId: r.leadId, key: "driving_type", verifiedValue: v.drivingType, verifiedById: user.id, verifiedAt: new Date(), status: "CORRECTED" } });
  }
  await recordEvent({ leadId: r.leadId, actorType: "USER", actorId: user.id, type: "OWN_DRIVER", message: `Own driver added by ${user.name} (not a lead; Crystal does not call)` });
  return { leadId: r.leadId, existed: false };
}

/** Audio type of an uploaded call: mp3, wav, m4a or ogg. */
export function uploadType(b: Buffer): { mime: string; ext: string } | null {
  const t = audioType(b);
  if (t) return t;
  if (b.subarray(4, 8).toString("latin1") === "ftyp") return { mime: "audio/mp4", ext: "m4a" };
  if (b.subarray(0, 4).toString("latin1") === "OggS") return { mime: "audio/ogg", ext: "ogg" };
  return null;
}

/** Saves the recording on the driver's page and queues the transcription. */
export async function saveUploadedRecording(user: User, leadId: string, file: { name: string; data: Buffer }) {
  if (file.data.length > MAX_UPLOAD_BYTES) return { error: "The recording is bigger than 40 MB" };
  const t = uploadType(file.data);
  if (!t) return { error: "Upload an mp3, wav, m4a or ogg recording" };
  const lead = await db.lead.findFirst({ where: { id: leadId, orgId: user.orgId } });
  if (!lead) return { error: "Driver not found" };
  const now = new Date();
  const a = await db.callAttempt.create({ data: {
    leadId, isDemo: lead.isDemo, provider: UPLOAD_PROVIDER, idempotencyKey: `upload:${randomToken(12)}`, direction: "RECRUITER",
    status: "COMPLETED", startedAt: now, metrics: { uploadedBy: user.name, fileName: file.name.slice(0, 200) },
  } });
  const key = `rec/${leadId}/${a.id}.${t.ext}`;
  await getAdapters().storage.put(key, file.data, t.mime);
  await db.callAttempt.update({ where: { id: a.id }, data: { recordingKey: key } });
  await recordEvent({ leadId, actorType: "USER", actorId: user.id, type: "RECORDING_UPLOADED", message: `Call recording uploaded by ${user.name} (${Math.round(file.data.length / 1024)} KB); Crystal is filling the form from it` });
  await enqueue("call.transcribe-upload", { attemptId: a.id }, { idempotencyKey: `transcribe:${a.id}`, maxAttempts: 3 });
  return { attemptId: a.id };
}

type Word = { word?: string; punctuated_word?: string; speaker?: number };
type SttResult = { text?: string; duration?: number; segments?: { text?: string; speaker?: number; speakers?: number[] }[]; words?: Word[] };

/** Speech-to-text reply -> turns. Exported for tests. */
export function sttTurns(r: SttResult): { speaker: string; text: string }[] {
  const words = r.words ?? [];
  if (words.some((w) => typeof w.speaker === "number")) {
    const turns: { speaker: string; text: string }[] = [];
    for (const w of words) {
      const speaker = `speaker_${(w.speaker ?? 0) + 1}`;
      const word = w.punctuated_word ?? w.word ?? "";
      const last = turns[turns.length - 1];
      if (last?.speaker === speaker) last.text += ` ${word}`; else turns.push({ speaker, text: word });
    }
    return turns.filter((t) => t.text.trim());
  }
  const text = (r.segments?.length ? r.segments.map((s) => s.text ?? "").join(" ") : r.text ?? "").replace(/\s+/g, " ").trim();
  return text ? [{ speaker: "call", text }] : [];
}

const STT_URL = "https://api.telnyx.com/v2/ai/audio/transcriptions";

/** Job: recording -> text (with speakers when the model can tell them apart) -> profile answers. */
export async function transcribeUpload(attemptId: string) {
  const a = await db.callAttempt.findUnique({ where: { id: attemptId } });
  if (!a?.recordingKey || a.provider !== UPLOAD_PROVIDER) return { filled: [] as string[] };
  if (!config.telnyx.apiKey) {
    await recordEvent({ leadId: a.leadId, actorType: "SYSTEM", type: "TRANSCRIPT_ANSWERS", message: "Recording saved, but it cannot be turned into text: TELNYX_API_KEY is not set" });
    return { filled: [] };
  }
  const data = await getAdapters().storage.get(a.recordingKey);
  const ext = a.recordingKey.split(".").pop()!;
  // Deepgram tells the two voices apart but takes only mp3 and wav.
  const deepgram = ext === "mp3" || ext === "wav";
  const form = new FormData();
  form.append("model", deepgram ? "deepgram/nova-3" : "openai/whisper-large-v3-turbo");
  form.append("file", new Blob([new Uint8Array(data)]), `call.${ext}`);
  form.append("response_format", "verbose_json");
  if (deepgram) form.append("model_config", JSON.stringify({ diarize: true, smart_format: true, punctuate: true }));
  const res = await providerFetch(STT_URL, { method: "POST", headers: { Authorization: `Bearer ${config.telnyx.apiKey}` }, body: form, timeoutMs: 300_000 });
  const body = (await res.json()) as SttResult & { data?: SttResult };
  const turns = sttTurns(body.data ?? body).map((t) => ({ ...t, text: redactText(t.text) }));
  const seconds = Math.round((body.data ?? body).duration ?? 0);
  await db.callAttempt.update({ where: { id: a.id }, data: {
    transcript: turns as unknown as Prisma.InputJsonValue,
    endedAt: seconds && a.startedAt ? new Date(a.startedAt.getTime() + seconds * 1000) : undefined,
  } });
  if (!turns.length) {
    await recordEvent({ leadId: a.leadId, actorType: "SYSTEM", type: "TRANSCRIPT_ANSWERS", message: "No speech found in the uploaded recording" });
    return { filled: [] };
  }
  const filled = await fillScreeningFromTranscript(a.id);
  return { filled };
}
