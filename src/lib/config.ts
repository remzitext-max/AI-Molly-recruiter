// Central runtime configuration. Secrets are read only on the server.
export type AppMode = "demo" | "live";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

export const config = {
  get mode(): AppMode {
    return env("APP_MODE") === "live" ? "live" : "demo";
  },
  get appUrl(): string {
    return env("APP_URL") ?? "http://localhost:3000";
  },
  get storageDir(): string {
    return env("STORAGE_DIR") ?? "./storage";
  },
  get sessionSecret(): string {
    const s = env("SESSION_SECRET");
    if (!s && process.env.NODE_ENV === "production") throw new Error("SESSION_SECRET is required");
    return s ?? "dev-only-session-secret-change-me";
  },
  get webhookSecret(): string | undefined {
    return env("WEBHOOK_SIGNING_SECRET");
  },
  get leadWebhookSecret(): string | undefined {
    return env("LEAD_WEBHOOK_SECRET");
  },
  // Live provider credentials. Presence is checked, never exposed to the browser.
  retell: {
    get apiKey() { return env("RETELL_API_KEY"); },
    get agentId() { return env("RETELL_AGENT_ID"); },
    get fromNumber() { return env("RETELL_FROM_NUMBER"); },
  },
  /** Which live voice-agent provider places AI calls: "retell" (default) or "telnyx". */
  get voiceProvider(): "retell" | "telnyx" {
    return env("VOICE_PROVIDER") === "telnyx" ? "telnyx" : "retell";
  },
  /** How the live agent introduces itself, e.g. "Crystal, Molly's assistant". */
  agentPersona: {
    get name() { return env("AGENT_NAME") ?? "Crystal"; },
    get role() { return env("AGENT_ROLE") ?? "Molly's assistant"; },
  },
  telnyx: {
    get apiKey() { return env("TELNYX_API_KEY"); },
    get assistantId() { return env("TELNYX_ASSISTANT_ID"); },
    /** TeXML application ID the AI call is placed through (the assistant's default_texml_app_id). */
    get texmlAppId() { return env("TELNYX_TEXML_APP_ID"); },
    get fromNumber() { return env("TELNYX_FROM_NUMBER"); },
    /** Optional: enables call-status lookups for reconciliation. */
    get accountSid() { return env("TELNYX_ACCOUNT_SID"); },
    /** Shared secret Telnyx sends back on tool and status requests (set in the assistant by scripts/telnyx-setup.ts). */
    get webhookToken() { return env("TELNYX_WEBHOOK_TOKEN"); },
  },
  ringcentral: {
    get serverUrl() { return env("RINGCENTRAL_SERVER_URL") ?? "https://platform.ringcentral.com"; },
    get clientId() { return env("RINGCENTRAL_CLIENT_ID"); },
    get clientSecret() { return env("RINGCENTRAL_CLIENT_SECRET"); },
    get jwt() { return env("RINGCENTRAL_JWT"); },
    get smsFromNumber() { return env("RINGCENTRAL_SMS_FROM"); },
  },
  heygen: {
    get apiKey() { return env("HEYGEN_API_KEY"); },
  },
  googleSheets: {
    get spreadsheetId() { return env("GOOGLE_SHEETS_SPREADSHEET_ID"); },
    /** A1 range or tab name, e.g. "Leads" or "Leads!A1:Z". Default "A:Z" = first tab. First row must be headers. */
    get range() { return env("GOOGLE_SHEETS_RANGE") ?? "A:Z"; },
    /** Header of the optional lead ID column. Rows with an empty ID are identified by phone number instead. */
    get idColumn() { return env("GOOGLE_SHEETS_ID_COLUMN"); },
    /** Optional header of a column the app may write the candidate's progress into. */
    get statusColumn() { return env("GOOGLE_SHEETS_STATUS_COLUMN"); },
    get serviceAccountEmail() { return env("GOOGLE_SERVICE_ACCOUNT_EMAIL"); },
    get privateKey() { return env("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")?.replace(/\\n/g, "\n"); },
  },
  elevenlabs: {
    get apiKey() { return env("ELEVENLABS_API_KEY"); },
  },
};

export const isDemo = () => config.mode === "demo";
