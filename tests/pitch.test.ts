import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { DEFAULT_PITCH, pitchFor, pitchVariables } from "@/lib/pitch";
import { buildAgentPrompt } from "@/lib/agent-config";
import { resetDb } from "./helpers";

describe("company call pitch", () => {
  it("keeps TBT's wording by default and lets a team sell its own offer", async () => {
    await resetDb();
    const main = await db.organization.create({ data: { name: "TBT express", isMain: true } });
    const team = await db.organization.create({ data: { name: "Other carrier", isMain: false, pitch: { hook: "We pay 70 cents per mile on reefer. How many miles do you run?", teamPay: "" } } });
    const v = pitchVariables(await pitchFor(main));
    expect(v.pitch_hook).toContain("85 cents per mile");
    expect(v.team_pay).toBe("$1 to $1.10 per mile");
    expect(v.company_rules).toMatch(/^- Whenever you mention 85 cents/);
    const t = pitchVariables(await pitchFor(team));
    expect(t.pitch_hook).toBe("We pay 70 cents per mile on reefer. How many miles do you run?");
    expect(t.team_pay).toBe(DEFAULT_PITCH.teamPay);
    // A team with no pitch uses the main company's own pitch.
    await db.organization.update({ where: { id: main.id }, data: { pitch: { equipment: "reefer" } } });
    expect((await pitchFor({ isMain: false, pitch: null })).equipment).toBe("reefer");
    const prompt = await buildAgentPrompt("{{company_name}}");
    expect(prompt).toContain('"{{pitch_hook}}"');
    expect(prompt).not.toContain("85 cents");
  });
});
