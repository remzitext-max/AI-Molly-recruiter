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

describe("dashboard card lists", () => {
  it("shows what Crystal got, counting only calls after an old lead was picked", async () => {
    const { leadRow, sheetRowItems } = await import("@/lib/dashboard-lists");
    const t = (h: number) => new Date(Date.UTC(2026, 10, 12, h));
    const talked = (c: { outcome: string | null }) => ["INTERESTED", "NOT_INTERESTED", "CALLBACK"].includes(c.outcome ?? "");
    const lead = { id: "l1", orgId: "o1", firstName: "Ken", lastName: "Wu", phoneE164: "+13125550101", recruiterStatus: "Need to talk", assignedTo: { name: "Molly" },
      calls: [{ id: "c1", createdAt: t(1), status: "COMPLETED", outcome: "INTERESTED" }, { id: "c2", createdAt: t(5), status: "COMPLETED", outcome: "NO_CONTACT" }] };
    expect(leadRow(lead, talked, null)).toMatchObject({ talked: true, interested: true, item: { sub: "Molly · Interested", badge: "Need to talk", tone: "ok" } });
    // Picked at 3:00: the 1:00 "interested" was before, so it does not count for the old-leads card.
    expect(leadRow(lead, talked, "TBT", { since: t(3), was: "Need to talk" })).toMatchObject({ talked: false, interested: false, item: { sub: "TBT · Molly · was Need to talk · No answer · 1 call", tone: "warn" } });
    expect(leadRow({ ...lead, calls: [] }, talked, null).item).toMatchObject({ sub: "Molly · Not called yet", tone: "late" });

    const rows = sheetRowItems(
      [{ id: "r1", orgId: "o1", phoneE164: "+13125550101", tab: "Molly", status: "Need to talk", name: null }, { id: "r2", orgId: "o1", phoneE164: "+13125550102", tab: "Pool", status: "New", name: "Al Fox" }],
      [{ id: "l1", orgId: "o1", phoneE164: "+13125550101", firstName: "Ken", lastName: "Wu" }],
      (_o, tab) => (tab === "Molly" ? "Molly" : null), () => null,
    );
    expect(rows.map((r) => [r.reached, r.item.name, r.item.leadId, r.item.sub])).toEqual([[true, "Ken Wu", "l1", "Molly"], [false, "Al Fox", null, "Pool"]]);
  });
});
