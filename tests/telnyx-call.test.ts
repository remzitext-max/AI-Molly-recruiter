import { afterEach, describe, expect, it, vi } from "vitest";
import { TelnyxVoiceAgent } from "@/adapters/live/telnyx";
import { config } from "@/lib/config";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Telnyx outbound AI call request", () => {
  it("does not cap the whole call at 15 minutes: a transferred talk with the recruiter runs on", async () => {
    vi.stubEnv("TELNYX_API_KEY", "test-key");
    vi.stubEnv("TELNYX_ASSISTANT_ID", "assistant-1");
    vi.stubEnv("TELNYX_TEXML_APP_ID", "app-1");
    vi.stubEnv("TELNYX_FROM_NUMBER", "+13145550100");
    vi.stubEnv("TELNYX_WEBHOOK_TOKEN", "token-1");
    vi.stubEnv("CALL_RING_SECONDS", "");
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ call_sid: "v3:call-1" }), { status: 200 });
    });

    const r = await new TelnyxVoiceAgent().startOutboundCall({ attemptId: "attempt-1", leadId: "lead-1", toE164: "+13145550101", isDemoRecord: false, dynamicVariables: { driver_first_name: "Sam" } });

    expect(r).toEqual({ providerCallId: "v3:call-1" });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain("/texml/ai_calls/app-1");
    // The whole-call cap covers the recruiter's talk after a transfer; Crystal's own 15 minutes are the assistant's setting.
    expect(sent[0].body.TimeLimit).toBe(config.callTimeLimitSeconds);
    expect(config.callTimeLimitSeconds).toBeGreaterThanOrEqual(60 * 60);
    expect(config.callTimeLimitSeconds).toBeLessThanOrEqual(14400); // Telnyx's maximum
    expect(sent[0].body.Timeout).toBe(24);
    expect(sent[0].body.AIAssistantDynamicVariables).toMatchObject({ driver_first_name: "Sam", attempt_id: "attempt-1" });
  });
});
