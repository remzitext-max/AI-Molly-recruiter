import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { parseAdLead } from "@/lib/ad-leads";
import { POST } from "../app/api/webhooks/ad-leads/route";
import { resetDb, seedBase } from "./helpers";

const googleBody = (over: Record<string, unknown> = {}) => ({
  lead_id: "TeSter-123", api_version: "1.0", form_id: 4000, campaign_id: 5000, google_key: "k-secret", is_test: false,
  user_column_data: [
    { column_name: "Full Name", string_value: "John Smith", column_id: "FULL_NAME" },
    { column_name: "User Phone", string_value: "+12145550123", column_id: "PHONE_NUMBER" },
    { column_name: "State", string_value: "TX", column_id: "REGION" },
    { column_name: "Solo or team?", string_value: "Team", column_id: "solo_or_team" },
    { column_name: "Any SAP / drug or alcohol violation?", string_value: "No", column_id: "sap" },
  ],
  ...over,
});
const post = (body: unknown, q = "") => POST(new Request(`http://x/api/webhooks/ad-leads${q}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

describe("ad platform leads (YouTube / TikTok)", () => {
  beforeEach(async () => { await resetDb(); process.env.AD_LEADS_KEY = "k-secret"; });

  it("parses a Google Ads lead form webhook", () => {
    const p = parseAdLead(googleBody());
    if ("error" in p) throw new Error(p.error);
    expect(p.lead).toMatchObject({ sourceSystem: "GOOGLE_ADS", sourceRecordId: "TeSter-123", firstName: "John", lastName: "Smith", phone: "+12145550123", state: "TX" });
    expect((p.lead.raw as { position?: string }).position).toBe("Team");
    expect(p.sapYes).toBe(false);
  });

  it("creates the lead, rejects a bad key, ignores Google's test send", async () => {
    await seedBase();
    expect((await post(googleBody({ google_key: "wrong" }))).status).toBe(401);
    expect(await (await post(googleBody({ is_test: true }))).json()).toEqual({ result: "test_ok" });
    expect(await db.lead.count()).toBe(0);
    const r = await (await post(googleBody())).json();
    expect(r.result).toBe("created");
    const lead = await db.lead.findUniqueOrThrow({ where: { id: r.leadId } });
    expect(lead.firstName).toBe("John");
    expect(await db.job.count({ where: { type: "lead.attempt-call" } })).toBeGreaterThan(0);
    expect((await (await post(googleBody())).json()).result).toBe("duplicate_source");
  });

  it("takes flat TikTok leads with ?key and does not auto-call SAP yes", async () => {
    await seedBase();
    const r = await (await post({ lead_id: "tt-1", name: "Ali Vali", phone: "(312) 555-0144", sap: "Yes" }, "?platform=tiktok&key=k-secret")).json();
    expect(r.result).toBe("created");
    const src = await db.leadSourceRecord.findFirstOrThrow({ where: { leadId: r.leadId } });
    expect(src.sourceSystem).toBe("TIKTOK");
    expect(await db.job.count({ where: { type: "lead.attempt-call" } })).toBe(0);
  });
});

describe("ad leads sheet", () => {
  beforeEach(async () => { await resetDb(); process.env.AD_LEADS_KEY = "k-secret"; });

  it("builds a row with the Source column and queues it when AD_LEADS_SHEET_ID is set", async () => {
    const { adLeadRow } = await import("@/lib/ad-leads-sheet");
    const p = parseAdLead({ platform: "tiktok", name: "Ann Lee", phone: "+13125550111", state: "IL", position: "Solo", experience: "3 years", sap: "No", campaign: "TBT test" });
    if ("error" in p) throw new Error(p.error);
    const row = adLeadRow(p, "calling", new Date("2026-11-05T15:00:00Z"));
    expect(row.slice(1, 9)).toEqual(["TikTok", "Ann Lee", "+13125550111", "", "IL", "Solo", "3 years", ""]);
    expect(row[0]).toContain("09:00");
    expect(row[10]).toBe("TBT test");

    await seedBase();
    process.env.AD_LEADS_SHEET_ID = "https://docs.google.com/spreadsheets/d/abc_DEF-1/edit#gid=0";
    try {
      const r = await (await post(googleBody())).json();
      expect(r.result).toBe("created");
      const job = await db.job.findFirstOrThrow({ where: { type: "sheet.ad-lead" } });
      expect((job.payload as { row: string[] }).row[1]).toBe("YouTube");
      const { config } = await import("@/lib/config");
      expect(config.adLeadsSheetId).toBe("abc_DEF-1");
    } finally { delete process.env.AD_LEADS_SHEET_ID; }
  });
});
