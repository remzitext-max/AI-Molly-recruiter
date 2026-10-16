import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { drainQueue } from "@/lib/jobs/queue";
import { handlers } from "@/lib/jobs/handlers";
import { SYNTHETIC_FACTS } from "@/lib/demo-data";
import { ingestLead } from "@/lib/leads";
import { setAdapterOverride } from "@/adapters/registry";

export async function resetDb() {
  const tables = await db.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`;
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
  setAdapterOverride(null);
  process.env.APP_MODE = "demo";
}

export async function seedBase(opts: { window?: [string, string]; days?: string; rr?: boolean } = {}) {
  await db.systemSetting.create({ data: { id: "global" } });
  const org = await db.organization.create({ data: { name: "Demo Freight" } });
  const pw = await bcrypt.hash("x", 4);
  const admin = await db.user.create({ data: { orgId: org.id, email: "admin@t.local", name: "Admin", role: "ADMIN", passwordHash: pw, inRoundRobin: false } });
  const molly = await db.user.create({ data: { orgId: org.id, email: "molly@t.local", name: "Molly", role: "RECRUITER", passwordHash: pw, availableForTransfer: true, transferPhoneE164: "+12145550199" } });
  const alex = await db.user.create({ data: { orgId: org.id, email: "alex@t.local", name: "Alex", role: "RECRUITER", passwordHash: pw, createdAt: new Date(Date.now() + 1000) } });
  const offer = await db.offer.create({ data: { orgId: org.id, name: "Synthetic offer" } });
  const v = await db.offerVersion.create({ data: { offerId: offer.id, version: 1, status: "PUBLISHED", synthetic: true, facts: SYNTHETIC_FACTS, publishedAt: new Date() } });
  await db.offer.update({ where: { id: offer.id }, data: { activeVersionId: v.id } });
  const campaign = await db.campaign.create({
    data: { orgId: org.id, name: "Test", isDemo: true, offerId: offer.id, assignmentMode: opts.rr === false ? "MANUAL" : "ROUND_ROBIN",
      contactWindowStart: opts.window?.[0] ?? "00:00", contactWindowEnd: opts.window?.[1] ?? "23:59", contactDays: opts.days ?? "1,2,3,4,5,6,7", maxAttempts: 3, retryDelayMinutes: 60 },
  });
  return { org, admin, molly, alex, offer, offerVersion: v, campaign };
}

let n = 0;
export async function addLead(base: Awaited<ReturnType<typeof seedBase>>, over: Partial<{ phone: string; state: string; zip: string; sourceRecordId: string; permission: boolean; first: string; sourceSystem: string }> = {}) {
  n++;
  const phone = over.phone ?? `(214) 555-01${String(n % 100).padStart(2, "0")}`;
  return ingestLead(
    {
      sourceSystem: over.sourceSystem ?? "CSV", sourceRecordId: over.sourceRecordId ?? `rec-${n}-${Date.now()}`, firstName: over.first ?? "Marcus", lastName: "Test",
      phone, state: over.state ?? "TX", zip: over.zip ?? "75201",
      permission: over.permission === false ? [] : [{ scope: "AI_CALL", source: "Test application form", grantedAt: new Date(Date.now() - 86400000).toISOString() }],
    },
    { orgId: base.org.id, campaignId: base.campaign.id, isDemo: true },
  );
}

/** Pin a lead's pending call job to a persona and make it due now. */
export async function setPersona(leadId: string, personaKey: string) {
  await db.$executeRaw`UPDATE "Job" SET payload = jsonb_set(payload, '{personaKey}', to_jsonb(${personaKey}::text)), "runAt" = now() WHERE payload->>'leadId' = ${leadId} AND status = 'PENDING'`;
}

export const drain = () => drainQueue(handlers);
