import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { resetDb, seedBase } from "./helpers";
import { loadDriverProfile, splitEmployers } from "@/lib/driver-profile";
import { profilePdf, pdfFileName } from "@/lib/profile-pdf";

beforeEach(async () => { await resetDb(); });

describe("driver profile popup and PDF", () => {
  it("splits the employers the driver listed", () => {
    expect(splitEmployers("Swift 03/2023-now, Werner 2021-03/2023; J.B. Hunt 2020")).toEqual(["Swift 03/2023-now", "Werner 2021-03/2023", "J.B. Hunt 2020"]);
    expect(splitEmployers("Pam Transport 1,5 years")).toEqual(["Pam Transport 1,5 years"]);
    expect(splitEmployers(null)).toEqual([]);
  });

  it("builds the profile from the driver's answers and writes it as a PDF", async () => {
    const base = await seedBase();
    const lead = await db.lead.create({ data: { orgId: base.org.id, campaignId: base.campaign.id, firstName: "Ray", lastName: "Brown 🚛", phoneE164: "+12255550198", state: "LA", assignedToId: base.molly.id } });
    const call = await db.callAttempt.create({ data: { leadId: lead.id, provider: "telnyx", idempotencyKey: "dp-1", status: "COMPLETED", outcome: "INTERESTED", summary: "Driver is interested.\n• 11 years OTR", startedAt: new Date(Date.now() - 300_000), endedAt: new Date(Date.now() - 100_000) } });
    for (const [key, reportedValue] of [["experience_years", "11 years"], ["rate_expectation", "83 cpm"], ["recent_companies", "Red River 03/2024-now, Lone Star 2022-2024"], ["work_type", "OTR"], ["accidents_at_fault", "no"], ["home_time", "4 weeks out"]]) {
      await db.screeningField.create({ data: { leadId: lead.id, key, reportedValue, callAttemptId: call.id } });
    }
    await db.screeningField.update({ where: { leadId_key: { leadId: lead.id, key: "experience_years" } }, data: { verifiedValue: "10 years" } });
    await db.activityEvent.create({ data: { leadId: lead.id, actorType: "USER", actorId: base.molly.id, type: "NOTE", message: "Spoke with Ray" } });

    const p = (await loadDriverProfile(base.admin, lead.id))!;
    expect(p.name).toBe("Ray Brown 🚛");
    expect(p.recruiter).toBe("Molly");
    expect(p.driver).toContainEqual(["Experience", "10 years (verified)"]);
    expect(p.driver).toContainEqual(["Accidents", "no"]);
    expect(p.deal).toContainEqual(["Rate expectation", "83 cpm"]);
    expect(p.employers).toEqual(["Red River 03/2024-now", "Lone Star 2022-2024"]);
    expect(p.calls[0]).toMatchObject({ length: "200 sec", result: "completed · interested" });
    expect(p.timeline[0]).toMatchObject({ who: "Molly", what: "Spoke with Ray" });

    // Another org's user cannot open it.
    const other = await db.organization.create({ data: { name: "Other" } });
    expect(await loadDriverProfile({ ...base.admin, orgId: other.id }, lead.id)).toBeNull();

    // Emoji and other characters the PDF font cannot draw are dropped, not an error.
    const pdf = await profilePdf(p, "Admin");
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
    expect(pdfFileName(p)).toMatch(/^Ray_Brown_profile_\d{4}-\d\d-\d\d\.pdf$/);
  });
});
