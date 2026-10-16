// Chooses adapters from APP_MODE + credentials. In demo mode every contact
// adapter is a mock. In live mode, adapters without credentials refuse to act.
import path from "node:path";
import { config } from "../lib/config";
import { MockExtractor, MockGoogleSheet, MockSms, MockSynth, MockTelephony, MockVoiceAgent } from "./mock";
import { RetellVoiceAgent } from "./live/retell";
import { RingCentralSms, RingCentralTelephony } from "./live/ringcentral";
import { HeyGenSynth } from "./live/heygen";
import { NoExtraction } from "./live/unconfigured";
import { GoogleSheetsSource } from "./live/google-sheets";
import { LocalPrivateStorage } from "./storage";
import type { DocumentExtractor, SheetLeadSource, DocumentStorage, IntegrationStatus, SmsProvider, TelephonyProvider, VoiceAgentProvider, VoiceSynthesizer } from "./types";

export interface Adapters {
  voice: VoiceAgentProvider;
  sms: SmsProvider;
  telephony: TelephonyProvider;
  storage: DocumentStorage;
  extraction: DocumentExtractor;
  synth: VoiceSynthesizer;
  sheets: SheetLeadSource;
}

let cache: { mode: string; a: Adapters } | null = null;
let override: Partial<Adapters> | null = null;

export function getAdapters(): Adapters {
  if (cache && cache.mode === config.mode && !override) return cache.a;
  const live = config.mode === "live";
  const a: Adapters = {
    voice: live ? new RetellVoiceAgent() : new MockVoiceAgent(),
    sms: live ? new RingCentralSms() : new MockSms(),
    telephony: live ? new RingCentralTelephony() : new MockTelephony(),
    storage: new LocalPrivateStorage(path.resolve(config.storageDir, "private")),
    extraction: live ? new NoExtraction() : new MockExtractor(),
    synth: live && config.heygen.apiKey ? new HeyGenSynth() : new MockSynth(),
    sheets: live ? new GoogleSheetsSource() : new MockGoogleSheet(),
  };
  const merged = { ...a, ...(override ?? {}) } as Adapters;
  if (!override) cache = { mode: config.mode, a: merged };
  return merged;
}

/** Test hook. */
export function setAdapterOverride(o: Partial<Adapters> | null) { override = o; cache = null; }

export function integrationStatuses(): IntegrationStatus[] {
  const a = getAdapters();
  const leadSources: IntegrationStatus[] = [
    { kind: "lead_source", provider: "CSV/XLSX upload", state: "configured", isMock: false, detail: "Admin upload with mapping preview and validation." },
    { kind: "lead_source", provider: "Manual entry", state: "configured", isMock: false, detail: "Admins can add single leads." },
    { kind: "lead_source", provider: "Signed lead webhook", state: config.leadWebhookSecret ? "configured" : "missing_credentials", isMock: false, detail: config.leadWebhookSecret ? "POST /api/webhooks/leads with HMAC signature." : "Set LEAD_WEBHOOK_SECRET to accept leads from another system." },
    a.sheets.status(),
  ];
  return [...leadSources, a.voice.status(), a.telephony.status(), a.sms.status(), a.storage.status(), a.extraction.status(), a.synth.status()];
}
