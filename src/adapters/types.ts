// Provider-independent integration interfaces. Every adapter reports an
// honest status: "mock", "configured", "missing_credentials", "blocked" or
// "not_implemented". Nothing labelled mock may ever contact a real person.

export type IntegrationState = "mock" | "configured" | "missing_credentials" | "blocked" | "not_implemented";

export interface IntegrationStatus {
  kind: "lead_source" | "voice_agent" | "telephony" | "sms" | "storage" | "extraction" | "voice_synthesis";
  provider: string;
  state: IntegrationState;
  isMock: boolean;
  detail: string;
  capabilities?: Record<string, "implemented" | "mocked" | "blocked" | "unverified">;
}

/** Thrown whenever an operation would contact a real person without full live configuration. */
export class LiveContactBlockedError extends Error {
  constructor(msg: string) { super(msg); this.name = "LiveContactBlockedError"; }
}

/** Provider request outcome is unknown (timeout, 5xx after send). Must be reconciled before retry. */
export class UncertainOutcomeError extends Error {
  constructor(msg: string) { super(msg); this.name = "UncertainOutcomeError"; }
}

// ---------- Lead source ----------
export interface IncomingLead {
  sourceSystem: string;
  sourceRecordId: string;
  firstName?: string; lastName?: string; phone: string; email?: string; state?: string; zip?: string;
  permission?: { scope: "AI_CALL" | "SMS"; source: string; grantedAt: string; evidence?: string }[];
  raw?: Record<string, unknown>;
}
export interface LeadSourceAdapter {
  key: string;
  status(): IntegrationStatus;
  fetchNew?(): Promise<IncomingLead[]>;
  pushResult?(sourceRecordId: string, result: Record<string, string>): Promise<void>;
}

/** A spreadsheet read as plain text: first row is headers. Formulas are never evaluated by this app. */
export interface SheetSnapshot { title: string; headers: string[]; rows: string[][]; warnings: string[] }

export interface SheetLeadSource {
  key: string;
  isMock: boolean;
  /** Header of the per-row ID column; rows are identified by it (or by phone when it is empty), never by row number. */
  idColumn: string | undefined;
  /** Header of the optional column the app writes progress into (write-back is off when unset). */
  statusColumn: string | undefined;
  status(): IntegrationStatus;
  /** range: another tab ("gid:<id>" or A1); defaults to the configured one. */
  readSheet(range?: string): Promise<SheetSnapshot>;
  /** sourceRecordId "phone:+1..." matches the row by phone number in `phoneColumn`. */
  writeStatus(sourceRecordId: string, text: string, phoneColumn?: string): Promise<"written" | "row_not_found" | "ambiguous_id" | "not_enabled">;
}

// ---------- Voice agent ----------
export interface StartCallRequest {
  attemptId: string;
  leadId: string;
  toE164: string;
  isDemoRecord: boolean;
  dynamicVariables: Record<string, string>;
  personaKey?: string | null; // mock only
  /** Ask the provider to record the call (only when the agent announces recording). */
  record?: boolean;
}
export interface ProviderCallStatus {
  status: "dialing" | "ringing" | "in_progress" | "completed" | "no_answer" | "busy" | "voicemail" | "failed" | "not_found";
  endedAt?: string;
}
export interface VoiceAgentProvider {
  key: string;
  isMock: boolean;
  status(): IntegrationStatus;
  startOutboundCall(req: StartCallRequest): Promise<{ providerCallId: string }>;
  getCallStatus(providerCallId: string): Promise<ProviderCallStatus>;
  /** Request a transfer. Success is only ever confirmed by a later provider event. */
  transferCall(providerCallId: string, toE164: string): Promise<{ accepted: boolean; detail?: string }>;
  supportsLiveTransfer(): boolean;
}

// ---------- Telephony (numbers, caller ID, human click-to-call) ----------
export interface TelephonyProvider {
  key: string;
  isMock: boolean;
  status(): IntegrationStatus;
  /** Connect a human recruiter's phone to the driver (e.g. RingCentral RingOut). */
  connectRecruiterToDriver(recruiterE164: string, driverE164: string): Promise<{ providerRef: string }>;
}

// ---------- SMS ----------
export interface SmsProvider {
  key: string;
  isMock: boolean;
  status(): IntegrationStatus;
  send(toE164: string, body: string, idempotencyKey: string): Promise<{ providerMessageId: string }>;
}

// ---------- Document storage ----------
export interface DocumentStorage {
  key: string;
  status(): IntegrationStatus;
  put(key: string, data: Buffer, mimeType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

// ---------- Optional document extraction ----------
export interface ExtractedField { name: string; value: string | null; confidence: number; uncertain: boolean }
export interface DocumentExtractor {
  key: string;
  status(): IntegrationStatus;
  extract(data: Buffer, mimeType: string): Promise<{ fields: ExtractedField[]; warnings: string[] }>;
}

// ---------- Voice synthesis (previews; live calls stream through the voice agent) ----------
export interface VoiceSynthesizer {
  key: string;
  isMock: boolean;
  status(): IntegrationStatus;
  synthesize(text: string, voiceId: string | null): Promise<{ audio: Buffer; mimeType: string; latencyMs: number }>;
}
