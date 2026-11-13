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
    const { crystalResult } = await import("@/lib/talked");
    const t = (h: number) => new Date(Date.UTC(2026, 10, 12, h));
    const none = new Set<string>();
    const lead = { id: "l1", orgId: "o1", firstName: "Ken", lastName: "Wu", phoneE164: "+13125550101", recruiterStatus: "Need to talk", assignedTo: { name: "Mona" },
      calls: [{ id: "c1", createdAt: t(1), status: "COMPLETED", outcome: "INTERESTED" }, { id: "c2", createdAt: t(5), status: "COMPLETED", outcome: "NO_CONTACT" }] };
    expect(leadRow(lead, none, null)).toMatchObject({ talked: true, interested: true, item: { sub: "Mona · Crystal: interested", badge: "Need to talk", tone: "ok" } });
    // Picked at 3:00: the 1:00 "interested" was before, so it does not count for the old-leads card.
    // The recruiter and the status are the sheet's (whose tab the driver is in), not the site's round-robin owner.
    expect(leadRow(lead, none, "TBT", { since: t(3), was: "Need to talk", sheet: { recruiter: "Dennis", status: "Call back" } }))
      .toMatchObject({ talked: false, interested: false, item: { sub: "TBT · Dennis · was Need to talk · Crystal: no answer, 1 call", badge: "Call back", tone: "warn" } });
    expect(leadRow({ ...lead, assignedTo: null, calls: [] }, none, null).item).toMatchObject({ sub: "no recruiter yet · Crystal: not called yet", tone: "late" });

    // The newest decision counts: yes, then no = not interested. Answers without a decision = talked.
    const calls = (...o: (string | null)[]) => o.map((outcome, i) => ({ id: `k${i}`, createdAt: t(i), status: "COMPLETED", outcome }));
    expect(crystalResult(calls("INTERESTED", "NOT_INTERESTED"), none)).toMatchObject({ talked: true, interested: false, text: "not interested" });
    expect(crystalResult(calls("INTERESTED", "NO_CONTACT"), none)).toMatchObject({ talked: true, interested: true, text: "interested" });
    expect(crystalResult(calls("INCOMPLETE"), new Set(["k0"]))).toMatchObject({ talked: true, interested: false, text: "talked, no clear yes or no" });
    expect(crystalResult(calls("NO_CONTACT", "OPT_OUT"), none)).toMatchObject({ talked: false, text: "asked not to call" });

    const rows = sheetRowItems(
      [{ id: "r1", orgId: "o1", phoneE164: "+13125550101", tab: "Molly", status: "Need to talk", name: null }, { id: "r2", orgId: "o1", phoneE164: "+13125550102", tab: "Pool", status: "New", name: "Al Fox" }],
      [{ id: "l1", orgId: "o1", phoneE164: "+13125550101", firstName: "Ken", lastName: "Wu" }],
      (_o, tab) => (tab === "Molly" ? "Molly" : null), () => null,
    );
    expect(rows.map((r) => [r.reached, r.item.name, r.item.leadId, r.item.sub])).toEqual([[true, "Ken Wu", "l1", "Molly"], [false, "Al Fox", null, "Pool"]]);
  });
});
