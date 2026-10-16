// Functional mock adapters for the local demo. They never touch a network.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../../lib/config";
import type {
  DocumentExtractor, IntegrationStatus, ProviderCallStatus, SheetLeadSource, SheetSnapshot, SmsProvider, StartCallRequest,
  TelephonyProvider, VoiceAgentProvider, VoiceSynthesizer,
} from "../types";
import { enqueue } from "../../lib/jobs/queue";
import { matchRows } from "../live/google-sheets";

const mockStatus = (kind: IntegrationStatus["kind"], provider: string, detail: string): IntegrationStatus => ({ kind, provider, state: "mock", isMock: true, detail });

export const mockCalls = new Map<string, ProviderCallStatus>();
export const mockTransferRequests: { providerCallId: string; to: string }[] = [];

export class MockVoiceAgent implements VoiceAgentProvider {
  key = "mock-voice";
  isMock = true;
  status() { return mockStatus("voice_agent", "Mock voice agent", "Simulated calls with synthetic driver personas. No phone network is used."); }
  async startOutboundCall(req: StartCallRequest) {
    const id = `mock_call_${crypto.randomUUID()}`;
    mockCalls.set(id, { status: "dialing" });
    // The simulation runs as a durable job so it survives worker restarts.
    await enqueue("call.simulate", { attemptId: req.attemptId, providerCallId: id, personaKey: req.personaKey ?? "interested" }, { idempotencyKey: `simulate:${req.attemptId}` });
    return { providerCallId: id };
  }
  async getCallStatus(id: string): Promise<ProviderCallStatus> {
    return mockCalls.get(id) ?? { status: "not_found" };
  }
  async transferCall(providerCallId: string, to: string) {
    mockTransferRequests.push({ providerCallId, to });
    return { accepted: true, detail: "Mock transfer requested; confirmation arrives as a simulated event" };
  }
  supportsLiveTransfer() { return true; }
}

export const mockSmsOutbox: { to: string; body: string; id: string }[] = [];
export class MockSms implements SmsProvider {
  key = "mock-sms";
  isMock = true;
  private sent = new Map<string, string>();
  status() { return mockStatus("sms", "Mock SMS", "Messages are stored in the app only; nothing is sent to a phone."); }
  async send(to: string, body: string, idempotencyKey: string) {
    const prior = this.sent.get(idempotencyKey);
    if (prior) return { providerMessageId: prior };
    const id = `mock_sms_${crypto.randomUUID()}`;
    this.sent.set(idempotencyKey, id);
    mockSmsOutbox.push({ to, body, id });
    // Demo-only "simulated phone" so testers can open the texted link.
    try {
      const dir = path.resolve(config.storageDir, "demo-outbox");
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.appendFile(path.join(dir, "sms.jsonl"), JSON.stringify({ to, body, id, at: new Date().toISOString() }) + "\n", { mode: 0o600 });
    } catch { /* best effort */ }
    return { providerMessageId: id };
  }
}

export class MockTelephony implements TelephonyProvider {
  key = "mock-telephony";
  isMock = true;
  status() { return mockStatus("telephony", "Mock telephony", "Simulated caller ID and click-to-call. No calls are placed."); }
  async connectRecruiterToDriver() { return { providerRef: `mock_ringout_${crypto.randomUUID()}` }; }
}

export class MockExtractor implements DocumentExtractor {
  key = "mock-extraction";
  status() { return mockStatus("extraction", "Mock extraction", "Returns placeholder fields marked uncertain. Not real OCR."); }
  async extract() {
    return {
      fields: [
        { name: "license_class", value: null, confidence: 0, uncertain: true },
        { name: "expiration_date", value: null, confidence: 0, uncertain: true },
        { name: "state", value: null, confidence: 0, uncertain: true },
      ],
      warnings: ["MOCK extraction: no fields were actually read. A human must review the document.", "A document image does not prove authenticity, license validity, identity or hiring eligibility."],
    };
  }
}

/** Generates a short tone WAV so the preview player works without a provider. */
export class MockSynth implements VoiceSynthesizer {
  key = "mock-voice-synthesis";
  isMock = true;
  status() { return mockStatus("voice_synthesis", "Mock voice", "Placeholder tone audio. This is NOT Molly's voice."); }
  async synthesize(text: string) {
    const t0 = Date.now();
    const rate = 8000;
    const secs = Math.min(3, 0.4 + text.length / 60);
    const n = Math.floor(rate * secs);
    const buf = Buffer.alloc(44 + n * 2);
    buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
    buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
    buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 3000 * (i % 4000 < 2000 ? 1 : 0.3)), 44 + i * 2);
    return { audio: buf, mimeType: "audio/wav", latencyMs: Date.now() - t0 };
  }
}

/** Demo mode only: read simulated texts sent to a number. */
export async function readDemoOutbox(toE164: string) {
  if (config.mode !== "demo") return [];
  try {
    const raw = await fs.readFile(path.resolve(config.storageDir, "demo-outbox", "sms.jsonl"), "utf8");
    return raw.trim().split("\n").map((l) => JSON.parse(l) as { to: string; body: string; at: string }).filter((m) => m.to === toE164);
  } catch { return []; }
}

// ---------- Demo Google Sheet ----------
// A local JSON file standing in for a Google Sheet, so the sync flow can be
// tried end to end without a Google account. Synthetic rows only.
export const DEMO_SHEET_HEADERS = ["Lead ID", "First Name", "Last Name", "Phone", "State", "ZIP", "Call consent source", "Call consent date", "AI status"];
const DEMO_SHEET_ROWS: string[][] = [
  ["GS-1001", "Dana", "Demo-Sheet", "(312) 555-0141", "IL", "60601", "Demo job application form", "2026-10-01", ""],
  ["GS-1002", "Luis", "Demo-Sheet", "(615) 555-0142", "TN", "37203", "Demo job application form", "2026-10-02", ""],
  ["", "No-ID", "Demo-Sheet", "(602) 555-0143", "AZ", "85004", "Demo job application form", "2026-10-03", ""],
];
const demoSheetFile = () => path.resolve(config.storageDir, "demo-sheet", "sheet.json");

export async function readDemoSheet(): Promise<{ headers: string[]; rows: string[][] }> {
  try { return JSON.parse(await fs.readFile(demoSheetFile(), "utf8")); }
  catch { return { headers: [...DEMO_SHEET_HEADERS], rows: DEMO_SHEET_ROWS.map((r) => [...r]) }; }
}
async function saveDemoSheet(s: { headers: string[]; rows: string[][] }) {
  await fs.mkdir(path.dirname(demoSheetFile()), { recursive: true });
  await fs.writeFile(demoSheetFile(), JSON.stringify(s, null, 1));
}
/** Append one synthetic row (555-01xx number) to the demo sheet. */
export async function addDemoSheetRow() {
  const s = await readDemoSheet();
  const n = s.rows.length + 1;
  const id = `GS-${1000 + n}`;
  const areas = ["404", "214", "713", "312", "615", "602"];
  s.rows.push([id, ["Rosa", "Kevin", "Jamal", "Erin"][n % 4], "Demo-Sheet", `(${areas[n % areas.length]}) 555-01${String(40 + n).padStart(2, "0").slice(-2)}`, "GA", "30303", "Demo job application form", new Date().toISOString().slice(0, 10), ""]);
  await saveDemoSheet(s);
  return id;
}
export async function resetDemoSheet() { await fs.rm(demoSheetFile(), { force: true }); }

export class MockGoogleSheet implements SheetLeadSource {
  key = "mock-google-sheet";
  isMock = true;
  idColumn = "Lead ID";
  statusColumn = "AI status";
  status() { return mockStatus("lead_source", "Google Sheets (demo sheet)", "A local demo sheet with synthetic rows stands in for your Google Sheet. No Google account is used."); }
  async readSheet(): Promise<SheetSnapshot> {
    const s = await readDemoSheet();
    return { title: "Demo sheet (local, synthetic)", headers: s.headers, rows: s.rows, warnings: [] };
  }
  async writeStatus(sourceRecordId: string, text: string, phoneColumn?: string) {
    const s = await readDemoSheet();
    const stI = s.headers.indexOf(this.statusColumn);
    const hits = matchRows(s.rows, s.headers.indexOf(this.idColumn), s.headers.indexOf(phoneColumn ?? ""), sourceRecordId).map((i) => s.rows[i]);
    if (!hits.length) return "row_not_found" as const;
    if (hits.length > 1) return "ambiguous_id" as const;
    hits[0][stI] = text;
    await saveDemoSheet(s);
    return "written" as const;
  }
}
