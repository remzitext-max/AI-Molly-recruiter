import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { isProviderLimitError, requeueLimitFailures } from "@/lib/calls";
import { resetDb, seedBase } from "./helpers";

beforeEach(async () => { await resetDb(); });

const D7 = 'Provider rejected request (403): {"errors":[{"code":"10010","detail":"Daily OB profile limit exceeded D7. Daily outbound concurrent call limit has been reached.","title":null}],"telnyx_error":{"error_code":"D7"}}';

describe("Telnyx daily spend limit", () => {
  it("recognises the limit error", () => {
    expect(isProviderLimitError(new Error(D7))).toBe(true);
    expect(isProviderLimitError(new Error("Provider rejected request (422): bad number"))).toBe(false);
  });

  it("gives refused calls their attempt back and queues the driver again", async () => {
    const base = await seedBase();
    const lead = await db.lead.create({ data: { orgId: base.org.id, campaignId: base.campaign.id, isDemo: false, firstName: "Lamont", phoneE164: "+13475521333", timezone: "America/New_York", attemptCount: 2, pipelineStatus: "QUEUED" } });
    await db.callAttempt.create({ data: { leadId: lead.id, provider: "telnyx", idempotencyKey: "job:x", status: "FAILED", outcome: "TECHNICAL_FAILURE", errorMessage: D7 } });
    expect(await requeueLimitFailures()).toEqual({ fixed: 1, queued: 1 });
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).attemptCount).toBe(1);
    expect(await db.job.count({ where: { type: "lead.attempt-call", status: "PENDING" } })).toBe(1);
    expect(await db.callAttempt.findFirstOrThrow({ where: { leadId: lead.id } })).toMatchObject({ status: "CANCELED", outcome: null });
    // A driver who already talked to Crystal is not called again by the repair.
    const talked = await db.lead.create({ data: { orgId: base.org.id, campaignId: base.campaign.id, isDemo: false, firstName: "Ray", phoneE164: "+13475521334", timezone: "America/New_York", attemptCount: 2, pipelineStatus: "QUEUED" } });
    await db.callAttempt.create({ data: { leadId: talked.id, provider: "telnyx", idempotencyKey: "job:t1", status: "COMPLETED", outcome: "INCOMPLETE" } });
    await db.callAttempt.create({ data: { leadId: talked.id, provider: "telnyx", idempotencyKey: "job:t2", status: "FAILED", outcome: "TECHNICAL_FAILURE", errorMessage: D7 } });
    expect(await requeueLimitFailures()).toEqual({ fixed: 1, queued: 0 });
    // Running it again changes nothing.
    expect(await requeueLimitFailures()).toEqual({ fixed: 0, queued: 0 });
  });
});
