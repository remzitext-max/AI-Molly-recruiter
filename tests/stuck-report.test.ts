import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { buildStuckReport } from "@/lib/stuck-report";
import { resetDb, seedBase } from "./helpers";

beforeEach(async () => { await resetDb(); });
const ago = (d: number) => new Date(Date.now() - d * 86400_000);

describe("morning stuck-drivers message", () => {
  it("counts, per recruiter, only the drivers past the Board's limit", async () => {
    const base = await seedBase();
    const orgId = base.org.id;
    await db.user.create({ data: { orgId, email: "alexp@x.test", name: "Alex P", role: "RECRUITER", passwordHash: "x" } });
    const row = (n: number, tab: string, status: string, statusDays: number) =>
      ({ orgId, phoneE164: `+1602555030${n}`, tab, status, appliedAt: ago(statusDays + 1), statusAt: ago(statusDays), name: `D${n}` });
    await db.sheetRow.createMany({ data: [
      row(1, "Alex P", "Need to talk", 3), // stuck (2d+)
      row(2, "Alex P", "Need to talk", 1), // not yet
      row(3, "Alex P", "Application", 8), // stuck (7d+)
      row(4, "Freya", "Call back", 5), // stuck, tab without a login
      row(5, "Freya", "Need teammate", 20), // not watched
    ] });
    const text = (await buildStuckReport(orgId))!;
    expect(text).toContain("<b>Alex P</b>: 1 Need to talk, 1 Application");
    expect(text).toContain("<b>Freya</b>: 1 Call back");
    expect(text).toContain("Total: 3.");
  });

  it("says nobody is stuck", async () => {
    const base = await seedBase();
    await db.sheetRow.create({ data: { orgId: base.org.id, phoneE164: "+16025550311", tab: "Mia", status: "Need to talk", appliedAt: ago(1), statusAt: ago(0.5), name: "D" } });
    expect(await buildStuckReport(base.org.id)).toContain("Nobody is stuck");
  });
});
