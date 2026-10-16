import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { DEMO_LEADS, DEMO_ORG_NAME, SYNTHETIC_FACTS } from "../src/lib/demo-data";

const db = new PrismaClient();

async function main() {
  const live = process.env.APP_MODE === "live";
  const adminPw = process.env.SEED_ADMIN_PASSWORD || (live ? "" : "demo-admin-pass");
  const recruiterPw = process.env.SEED_RECRUITER_PASSWORD || (live ? "" : "demo-recruiter-pass");
  if (live && (!adminPw || adminPw.length < 12)) throw new Error("Set SEED_ADMIN_PASSWORD (12+ chars) before seeding in live mode");

  await db.systemSetting.upsert({ where: { id: "global" }, create: { id: "global", cdlBySms: process.env.CDL_BY_SMS !== "false" }, update: {} });
  let org = await db.organization.findFirst();
  if (!org) org = await db.organization.create({ data: { name: live ? (process.env.ORG_NAME ?? "Your Company") : DEMO_ORG_NAME } });

  const admin = await db.user.upsert({
    where: { email: process.env.SEED_ADMIN_EMAIL ?? "admin@demo.local" },
    create: { orgId: org.id, email: process.env.SEED_ADMIN_EMAIL ?? "admin@demo.local", name: "Admin", role: "ADMIN", passwordHash: await bcrypt.hash(adminPw, 12), inRoundRobin: false },
    update: {},
  });
  if (live) { console.log(`Live seed complete. Admin: ${admin.email}`); return; }

  const molly = await db.user.upsert({
    where: { email: "molly@demo.local" },
    create: { orgId: org.id, email: "molly@demo.local", name: "Molly (demo account)", role: "RECRUITER", passwordHash: await bcrypt.hash(recruiterPw, 12), availableForTransfer: true, transferPhoneE164: "+12145550199" },
    update: {},
  });
  await db.user.upsert({
    where: { email: "alex@demo.local" },
    create: { orgId: org.id, email: "alex@demo.local", name: "Alex (demo recruiter)", role: "RECRUITER", passwordHash: await bcrypt.hash(recruiterPw, 12) },
    update: {},
  });

  let offer = await db.offer.findFirst({ where: { orgId: org.id } });
  if (!offer) {
    offer = await db.offer.create({ data: { orgId: org.id, name: "Regional Dry Van (SYNTHETIC DEMO OFFER)" } });
    const v = await db.offerVersion.create({ data: { offerId: offer.id, version: 1, status: "PUBLISHED", synthetic: true, facts: SYNTHETIC_FACTS, notes: "Synthetic demo facts. Replace with real approved facts before live use.", createdById: admin.id, publishedAt: new Date() } });
    await db.offer.update({ where: { id: offer.id }, data: { activeVersionId: v.id } });
  }

  let campaign = await db.campaign.findFirst({ where: { orgId: org.id, isDemo: true } });
  if (!campaign) campaign = await db.campaign.create({ data: { orgId: org.id, name: "Demo campaign (synthetic leads)", isDemo: true, offerId: offer.id, contactWindowStart: "00:00", contactWindowEnd: "23:59", contactDays: "1,2,3,4,5,6,7", maxAttempts: 3, retryDelayMinutes: 1 } });

  await db.voiceProfile.upsert({
    where: { name: "Molly Recruiting Assistant" },
    create: { name: "Molly Recruiting Assistant", provider: "mock", status: "MOCK", isMock: true, notes: "Placeholder. No voice has been cloned. Molly's recording has not been supplied yet." },
    update: {},
  });

  console.log(`Seeded demo org "${org.name}". Admin login: ${admin.email}. Demo recruiters: molly@demo.local, alex@demo.local.`);
  console.log(`Synthetic leads are created from the dashboard ("Load demo leads"), so you can watch them flow.`);
  void molly; void DEMO_LEADS;
}

main().finally(() => db.$disconnect());
