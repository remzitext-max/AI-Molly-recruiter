// Call recordings from Telnyx: downloaded once (the provider link is short-lived),
// kept in private storage, played on the lead page and sent with the Telegram card.
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

export async function fetchRecording(attemptId: string, url: string) {
  const a = await db.callAttempt.findUnique({ where: { id: attemptId } });
  if (!a || a.recordingKey || a.isDemo) return { saved: false };
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
