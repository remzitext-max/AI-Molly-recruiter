import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { inboundAttemptId, inboundInit } from "@/lib/inbound";
import { resetDb, seedBase } from "./helpers";

const init = (from: string, id: string) => ({ data: { event_type: "assistant.initialization", payload: { telnyx_conversation_channel: "phone_call", telnyx_end_user_target: from, telnyx_agent_target: "+13146900777", call_control_id: id } } });

describe("drivers calling Crystal's number", () => {
  it("creates a lead for a new caller, reuses a known lead, and leaves our outbound calls alone", async () => {
    await resetDb();
    const base = await seedBase();
    await db.organization.update({ where: { id: base.org.id }, data: { isMain: true } });
    await db.campaign.update({ where: { id: base.campaign.id }, data: { isDemo: false } });

    const r = await inboundInit(init("+13125550111", "v3:abc"));
    expect(r.dynamic_variables?.call_direction).toBe("inbound");
    expect(r.dynamic_variables?.opening_line).toMatch(/thanks for calling .*How can I help you\?/);
    const lead = await db.lead.findFirstOrThrow({ where: { phoneE164: "+13125550111" } });
    const a = await db.callAttempt.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(a.direction).toBe("INBOUND");
    expect(r.dynamic_variables?.attempt_id).toBe(a.id);
    // The same call asking again does not open a second attempt.
    await inboundInit(init("+13125550111", "v3:abc"));
    expect(await db.callAttempt.count({ where: { leadId: lead.id } })).toBe(1);
    // A status callback without our attempt id finds it by the caller's number.
    expect(await inboundAttemptId({ CallSid: "other", Direction: "inbound", From: "+13125550111" })).toBe(a.id);

    // Known driver: greeted by name.
    await db.callAttempt.update({ where: { id: a.id }, data: { status: "COMPLETED" } });
    await db.lead.update({ where: { id: lead.id }, data: { firstName: "Jamal", activeAttemptId: null } });
    const again = await inboundInit(init("+13125550111", "v3:def"));
    expect(again.dynamic_variables?.opening_line).toContain("Is this Jamal?");

    // Our own outbound call in progress: nothing to add.
    await db.callAttempt.create({ data: { leadId: lead.id, provider: "telnyx", idempotencyKey: "out-1", status: "DIALING", direction: "OUTBOUND" } });
    expect(await inboundInit(init("+13125550111", "v3:ghi"))).toEqual({});
  });
});
