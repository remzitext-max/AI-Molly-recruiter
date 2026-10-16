// RingCentral adapters: SMS and RingOut click-to-call for HUMAN recruiters.
// RingOut/Call Control do not provide AI audio; see docs/INTEGRATIONS.md.
import { config } from "../../lib/config";
import { providerFetch } from "./http";
import { LiveContactBlockedError, type IntegrationStatus, type SmsProvider, type TelephonyProvider } from "../types";

let cached: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  const c = config.ringcentral;
  if (!c.clientId || !c.clientSecret || !c.jwt) throw new LiveContactBlockedError("RingCentral credentials not configured");
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const res = await providerFetch(`${c.serverUrl}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: c.jwt }).toString(),
  });
  const j = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

function rcStatus(kind: IntegrationStatus["kind"], extraMissing: string[] = []): IntegrationStatus {
  const c = config.ringcentral;
  const missing = [!c.clientId && "RINGCENTRAL_CLIENT_ID", !c.clientSecret && "RINGCENTRAL_CLIENT_SECRET", !c.jwt && "RINGCENTRAL_JWT", ...extraMissing].filter(Boolean) as string[];
  return {
    kind, provider: "RingCentral", isMock: false,
    state: missing.length ? "missing_credentials" : "configured",
    detail: missing.length ? `Missing ${missing.join(", ")}` : "Credentials present. Account capabilities (SMS/TCR, RingOut) not yet verified.",
  };
}

export class RingCentralSms implements SmsProvider {
  key = "ringcentral-sms";
  isMock = false;
  status() {
    const s = rcStatus("sms", config.ringcentral.smsFromNumber ? [] : ["RINGCENTRAL_SMS_FROM"]);
    s.capabilities = { send_sms: "unverified", inbound_sms_webhook: "implemented", tcr_10dlc_registration: "blocked" };
    return s;
  }
  async send(to: string, body: string) {
    const from = config.ringcentral.smsFromNumber;
    if (!from) throw new LiveContactBlockedError("RINGCENTRAL_SMS_FROM not configured");
    const token = await accessToken();
    const res = await providerFetch(`${config.ringcentral.serverUrl}/restapi/v1.0/account/~/extension/~/sms`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: { phoneNumber: from }, to: [{ phoneNumber: to }], text: body }),
    });
    const j = (await res.json()) as { id: number | string };
    return { providerMessageId: `rc_${j.id}` };
  }
}

export class RingCentralTelephony implements TelephonyProvider {
  key = "ringcentral-ringout";
  isMock = false;
  status() {
    const s = rcStatus("telephony");
    s.capabilities = { ringout_click_to_call: "unverified", ai_realtime_audio: "blocked", call_control_transfer: "unverified", caller_id: "unverified" };
    s.detail += " RingCentral is used for human click-to-call and SMS; AI call audio runs through the voice-agent provider.";
    return s;
  }
  async connectRecruiterToDriver(recruiterE164: string, driverE164: string) {
    const token = await accessToken();
    const res = await providerFetch(`${config.ringcentral.serverUrl}/restapi/v1.0/account/~/extension/~/ring-out`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: { phoneNumber: recruiterE164 }, to: { phoneNumber: driverE164 }, playPrompt: false }),
    });
    const j = (await res.json()) as { id: string };
    return { providerRef: `rc_ringout_${j.id}` };
  }
}
