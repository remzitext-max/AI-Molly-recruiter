// Call recordings from Telnyx: the assistant records every answered call itself.
// We find that recording with GET /v2/recordings, download it once (the link is
// short-lived), keep it in private storage, play it on the lead page and send it
// with the Telegram card. Field names follow the Telnyx Node SDK types.
import { db } from "./db";
import { config } from "./config";
import { providerFetch } from "../adapters/live/http";
import { getAdapters } from "../adapters/registry";
import { recordEvent } from "./activity";

const MAX_BYTES = 40 * 1024 * 1024;

/** Audio type from the file's first bytes. Exported for tests. */
export function audioType(b: Buffer): { mime: string; ext: string } | null {
  if (b.subarray(0, 3).toString("latin1") === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { mime: "audio/mpeg", ext: "mp3" };
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WAVE") return { mime: "audio/wav", ext: "wav" };
  return null;
}

type TelnyxRecording = { to?: string; from?: string; created_at?: string; download_urls?: { mp3?: string; wav?: string } };

/** The recording of this call: made around the call's time, to or from the driver's number. */
export async function findTelnyxRecordingUrl(a: { startedAt: Date | null; endedAt: Date | null }, phoneE164: string): Promise<string | null> {
  if (!config.telnyx.apiKey || !a.startedAt) return null;
  const q = new URLSearchParams({
    "filter[created_at][gte]": new Date(a.startedAt.getTime() - 2 * 60_000).toISOString(),
    "filter[created_at][lte]": new Date((a.endedAt ?? a.startedAt).getTime() + 15 * 60_000).toISOString(),
    "page[size]": "50",
  });
  const res = await providerFetch(`https://api.telnyx.com/v2/recordings?${q}`, { headers: { Authorization: `Bearer ${config.telnyx.apiKey}` } });
  const body = (await res.json()) as { data?: TelnyxRecording[] };
  const digits = phoneE164.replace(/\D/g, "").slice(-10);
  const r = (body.data ?? []).find((x) => [x.to, x.from].some((n) => (n ?? "").replace(/\D/g, "").endsWith(digits)) && (x.download_urls?.mp3 || x.download_urls?.wav));
  return r ? (r.download_urls!.mp3 ?? r.download_urls!.wav!) : null;
}

export async function fetchRecording(attemptId: string, url?: string) {
  const a = await db.callAttempt.findUnique({ where: { id: attemptId }, include: { lead: { select: { phoneE164: true } } } });
  if (!a || a.recordingKey || a.isDemo) return { saved: false };
  if (!url) {
    // Throwing makes the job retry: Telnyx lists the recording shortly after the call.
    url = (await findTelnyxRecordingUrl(a, a.lead.phoneE164)) ?? undefined;
    if (!url) throw new Error("Recording not found yet");
  }
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("Recording link is not https");
  // Telnyx API links need the API key; pre-signed storage links must not get it.
  const headers: Record<string, string> = u.hostname === "api.telnyx.com" && config.telnyx.apiKey ? { Authorization: `Bearer ${config.telnyx.apiKey}` } : {};
  const res = await providerFetch(url, { headers, timeoutMs: 120_000 });
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_BYTES) throw new Error("Recording too large");
  const t = audioType(data);
  if (!t) throw new Error("Recording is not an mp3 or wav file");
  const key = `rec/${a.leadId}/${a.id}.${t.ext}`;
  await getAdapters().storage.put(key, data, t.mime);
  await db.callAttempt.update({ where: { id: a.id }, data: { recordingKey: key } });
  await recordEvent({ leadId: a.leadId, actorType: "SYSTEM", type: "RECORDING_SAVED", message: `Call recording saved (${Math.round(data.length / 1024)} KB)` });
  return { saved: true };
}

export const recordingMime = (key: string) => (key.endsWith(".wav") ? "audio/wav" : "audio/mpeg");
