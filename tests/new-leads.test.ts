import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ingestLead } from "@/lib/leads";
import { firstSource, isNewApplicant, leadOrigin } from "@/lib/new-leads";
import { RECALL_PREFIX } from "@/lib/sheet-recall";
import { resetDb, seedBase } from "./helpers";

beforeEach(async () => { await resetDb(); });

describe("new applicants on the dashboards", () => {
  it("leaves out leads made by re-calls, old leads and referrals, but not an applicant revived later", async () => {
    const base = await seedBase();
    const opts = { orgId: base.org.id, campaignId: base.campaign.id, isDemo: true, actorId: null, scheduleOutreach: false };
    const add = (sourceSystem: string, sourceRecordId: string, phone: string) => ingestLead({ sourceSystem, sourceRecordId, phone, firstName: "D" }, opts);
    await add("WEBHOOK", "fb-1", "+13125550101");
    await add("GOOGLE_SHEETS", `${RECALL_PREFIX}row-2`, "+13125550102");
    await add("REVIVE", `revive:${base.org.id}:+13125550103`, "+13125550103");
    await add("REFERRAL", "referral:x:+13125550104", "+13125550104");
    // The Facebook applicant is picked again later as an old lead: still an applicant.
    await add("REVIVE", `revive:${base.org.id}:+13125550101`, "+13125550101");

    const leads = await db.lead.findMany({ select: { ...firstSource, phoneE164: true }, orderBy: { phoneE164: "asc" } });
    expect(leads.map(leadOrigin)).toEqual(["applicant", "recall", "revive", "referral"]);
    expect(leads.filter(isNewApplicant).map((l) => l.phoneE164)).toEqual(["+13125550101"]);
  });
});
