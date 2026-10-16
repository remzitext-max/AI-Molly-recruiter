// HeyGen voice TTS for PRIVATE PREVIEWS only. HeyGen voices are bound to the
// HeyGen workspace and are not usable by phone voice-agent providers.
import { config } from "../../lib/config";
import { providerFetch } from "./http";
import type { IntegrationStatus, VoiceSynthesizer } from "../types";

export class HeyGenSynth implements VoiceSynthesizer {
  key = "heygen";
  isMock = false;
  status(): IntegrationStatus {
    return {
      kind: "voice_synthesis", provider: "HeyGen", isMock: false,
      state: config.heygen.apiKey ? "configured" : "missing_credentials",
      detail: config.heygen.apiKey
        ? "API key present. Voice clone permission (403 check) not yet verified. Previews only; not usable for live phone calls."
        : "HEYGEN_API_KEY not set. No HeyGen integration was found in this workspace.",
      capabilities: { voice_clone_api: "unverified", tts_preview: "unverified", live_phone_audio: "blocked" },
    };
  }
  async synthesize(text: string, voiceId: string | null) {
    if (!config.heygen.apiKey) throw new Error("HEYGEN_API_KEY not configured");
    if (!voiceId) throw new Error("No HeyGen voice ID saved for this profile");
    const t0 = Date.now();
    const res = await providerFetch("https://api.heygen.com/v3/models/audio/tts", {
      method: "POST",
      headers: { "X-Api-Key": config.heygen.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ voice_id: voiceId, text, model: "heygen-voice-1", language: "en" }),
      timeoutMs: 60000,
    });
    const ct = res.headers.get("content-type") ?? "";
    let audio: Buffer;
    if (ct.includes("application/json")) {
      // Some responses return a URL to the generated file.
      const j = (await res.json()) as { data?: { audio_url?: string; url?: string } };
      const url = j.data?.audio_url ?? j.data?.url;
      if (!url) throw new Error("HeyGen TTS response had no audio");
      audio = Buffer.from(await (await providerFetch(url, { method: "GET" })).arrayBuffer());
    } else {
      audio = Buffer.from(await res.arrayBuffer());
    }
    return { audio, mimeType: "audio/wav", latencyMs: Date.now() - t0 };
  }
}
