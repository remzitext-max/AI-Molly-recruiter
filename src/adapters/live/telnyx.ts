// Telnyx AI Assistant voice-agent adapter. Calls are placed with
// POST /v2/texml/ai_calls/{texml_app_id}; status arrives on TeXML status callbacks.
// Field names follow the Telnyx Node SDK types; not yet exercised with a live call.
import crypto from "node:crypto";
import { config } from "../../lib/config";
import { providerFetch } from "./http";
import { LiveContactBlockedError, type IntegrationStatus, type ProviderCallStatus, type StartCallRequest, type VoiceAgentProvider } from "../types";

const BASE = "https://api.telnyx.com/v2";

export class TelnyxVoiceAgent implements VoiceAgentProvider {
  key = "telnyx";
  isMock = false;
  status(): IntegrationStatus {
    const c = config.telnyx;
    const missing = [!c.apiKey && "TELNYX_API_KEY", !c.assistantId && "TELNYX_ASSISTANT_ID", !c.texmlAppId && "TELNYX_TEXML_APP_ID", !c.fromNumber && "TELNYX_FROM_NUMBER", !c.webhookToken && "TELNYX_WEBHOOK_TOKEN"].filter(Boolean);
    return {
      kind: "voice_agent", provider: "Telnyx AI Assistant", isMock: false,
      state: missing.length ? "missing_credentials" : "configured",
      detail: missing.length ? `Missing ${missing.join(", ")}` : "Credentials present. Not yet verified with a live test call.",
      capabilities: {
        outbound_call: "unverified", realtime_audio: "unverified", voicemail_detection: "unverified",
        live_transfer: "unverified", webhooks: "implemented",
      },
    };
  }
  private headers() {
    if (!config.telnyx.apiKey) throw new LiveContactBlockedError("Telnyx API key not configured");
    return { Authorization: `Bearer ${config.telnyx.apiKey}`, "Content-Type": "application/json" };
  }
  async startOutboundCall(req: StartCallRequest) {
    if (req.isDemoRecord) throw new LiveContactBlockedError("Demo records can never be dialed by a live provider");
    const { assistantId, texmlAppId, fromNumber, webhookToken } = config.telnyx;
    if (!assistantId || !texmlAppId || !fromNumber || !webhookToken) throw new LiveContactBlockedError("Telnyx assistant / TeXML app / from number / webhook token not configured");
    const callback = `${config.appUrl}/api/webhooks/telnyx?token=${encodeURIComponent(webhookToken)}&attempt_id=${encodeURIComponent(req.attemptId)}`;
    const res = await providerFetch(`${BASE}/texml/ai_calls/${encodeURIComponent(texmlAppId)}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        From: fromNumber,
        To: req.toE164,
        AIAssistantId: assistantId,
        AIAssistantDynamicVariables: { ...req.dynamicVariables, attempt_id: req.attemptId },
        StatusCallback: callback,
        StatusCallbackEvent: "initiated ringing answered completed no-answer busy canceled failed",
        StatusCallbackMethod: "POST",
        ConversationCallback: callback,
        TimeLimit: 15 * 60,
      }),
    });
    const body = (await res.json()) as { call_sid?: string; data?: { call_sid?: string } };
    const sid = body.call_sid ?? body.data?.call_sid;
    if (!sid) throw new Error("Telnyx response missing call_sid");
    return { providerCallId: sid };
  }
  async getCallStatus(id: string): Promise<ProviderCallStatus> {
    const sid = config.telnyx.accountSid;
    if (!sid) return { status: "dialing" }; // no lookup without the account SID; reconciliation retries later
    try {
      const res = await providerFetch(`${BASE}/texml/Accounts/${encodeURIComponent(sid)}/Calls/${encodeURIComponent(id)}`, { method: "GET", headers: this.headers() });
      const c = (await res.json()) as { status?: string };
      return { status: mapTelnyxStatus(c.status) };
    } catch (e) {
      if (/\(404\)/.test((e as Error).message)) return { status: "not_found" };
      throw e;
    }
  }
  async transferCall() {
    // The assistant's transfer tool performs the transfer; there is no REST call here.
    // No transfer event is delivered to us, so the transfer timeout job creates the callback task.
    return { accepted: false, detail: "Transfer is executed by the Telnyx assistant's transfer tool" };
  }
  supportsLiveTransfer() { return true; }
}

export function mapTelnyxStatus(status?: string): ProviderCallStatus["status"] {
  switch ((status ?? "").toLowerCase()) {
    case "queued": case "initiated": return "dialing";
    case "ringing": return "ringing";
    case "answered": case "in-progress": return "in_progress";
    case "completed": return "completed";
    case "no-answer": return "no_answer";
    case "busy": return "busy";
    case "canceled": case "failed": return "failed";
    default: return "dialing";
  }
}

/** Constant-time comparison of the shared webhook token. */
export function telnyxTokenOk(given: string | null | undefined): boolean {
  const want = config.telnyx.webhookToken;
  if (!want || !given) return false;
  const a = Buffer.from(want), b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
