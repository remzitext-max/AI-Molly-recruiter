// Retell AI voice-agent adapter (documented endpoints, see docs/INTEGRATIONS.md).
// Not exercised against a live account during development: no credentials
// were supplied and no real calls may be placed.
import crypto from "node:crypto";
import { config } from "../../lib/config";
import { providerFetch } from "./http";
import { LiveContactBlockedError, type IntegrationStatus, type ProviderCallStatus, type StartCallRequest, type VoiceAgentProvider } from "../types";

const BASE = "https://api.retellai.com";

export class RetellVoiceAgent implements VoiceAgentProvider {
  key = "retell";
  isMock = false;
  status(): IntegrationStatus {
    const c = config.retell;
    const missing = [!c.apiKey && "RETELL_API_KEY", !c.agentId && "RETELL_AGENT_ID", !c.fromNumber && "RETELL_FROM_NUMBER"].filter(Boolean);
    return {
      kind: "voice_agent", provider: "Retell AI", isMock: false,
      state: missing.length ? "missing_credentials" : "configured",
      detail: missing.length ? `Missing ${missing.join(", ")}` : "Credentials present. Not yet verified with a live test call.",
      capabilities: {
        outbound_call: "unverified", realtime_audio: "unverified", voicemail_detection: "unverified",
        live_transfer: "unverified", webhooks: "implemented",
      },
    };
  }
  private headers() {
    if (!config.retell.apiKey) throw new LiveContactBlockedError("Retell API key not configured");
    return { Authorization: `Bearer ${config.retell.apiKey}`, "Content-Type": "application/json" };
  }
  async startOutboundCall(req: StartCallRequest) {
    if (req.isDemoRecord) throw new LiveContactBlockedError("Demo records can never be dialed by a live provider");
    const { agentId, fromNumber } = config.retell;
    if (!agentId || !fromNumber) throw new LiveContactBlockedError("Retell agent ID / from number not configured");
    const res = await providerFetch(`${BASE}/v2/create-phone-call`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        from_number: fromNumber,
        to_number: req.toE164,
        override_agent_id: agentId,
        retell_llm_dynamic_variables: req.dynamicVariables,
        metadata: { attempt_id: req.attemptId, lead_id: req.leadId },
        idempotency_key: req.attemptId,
      }),
    });
    const body = (await res.json()) as { call_id?: string };
    if (!body.call_id) throw new Error("Retell response missing call_id");
    return { providerCallId: body.call_id };
  }
  async getCallStatus(id: string): Promise<ProviderCallStatus> {
    try {
      const res = await providerFetch(`${BASE}/v2/get-call/${encodeURIComponent(id)}`, { method: "GET", headers: this.headers() });
      const c = (await res.json()) as { call_status?: string; disconnection_reason?: string; end_timestamp?: number };
      return { status: mapRetellStatus(c.call_status, c.disconnection_reason), endedAt: c.end_timestamp ? new Date(c.end_timestamp).toISOString() : undefined };
    } catch (e) {
      if (/\(404\)/.test((e as Error).message)) return { status: "not_found" };
      throw e;
    }
  }
  async transferCall() {
    // Retell performs transfers from inside the agent (transfer_call tool or
    // custom-LLM `transfer_number`); there is no REST "transfer now" call.
    // Our agent requests it via the tool, and only transfer_* webhooks confirm it.
    return { accepted: false, detail: "Transfer is executed by the Retell agent tool; awaiting transfer_* webhook" };
  }
  supportsLiveTransfer() { return true; }
}

export function mapRetellStatus(status?: string, reason?: string): ProviderCallStatus["status"] {
  if (reason === "voicemail_reached") return "voicemail";
  if (reason === "dial_no_answer") return "no_answer";
  if (reason === "dial_busy") return "busy";
  if (reason === "dial_failed" || reason?.startsWith("error")) return "failed";
  switch (status) {
    case "registered": return "dialing";
    case "ongoing": return "in_progress";
    case "ended": return "completed";
    case "error": return "failed";
    default: return "dialing";
  }
}

/**
 * Verify X-Retell-Signature ("v=<ts>,d=<hex>") as described in Retell's
 * secure-webhook docs: HMAC-SHA256 keyed with the webhook API key over the raw
 * body followed by the timestamp, rejecting timestamps older than 5 minutes.
 * Validate against Retell's official SDK `verify()` during the account test.
 */
export function verifyRetellSignature(rawBody: string, header: string | null, apiKey: string, nowMs = Date.now()): boolean {
  if (!header) return false;
  const m = header.match(/v=(\d+),d=([a-f0-9]+)/i);
  if (!m) return false;
  const ts = Number(m[1]);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > 5 * 60 * 1000) return false;
  const expected = crypto.createHmac("sha256", apiKey).update(rawBody + m[1]).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(m[2].toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
