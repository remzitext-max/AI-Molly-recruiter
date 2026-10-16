// Loads approved offer facts from a JSON file as a new DRAFT offer version.
// An admin still reviews it in Knowledge, ticks the approval box and publishes.
//   docker compose exec web npx tsx scripts/load-offer.ts data/tbt-offer.json
import { readFileSync } from "node:fs";
import { db } from "../src/lib/db";
import { FactsSchema } from "../src/lib/knowledge";

async function main() {
  const file = process.argv[2] ?? "data/tbt-offer.json";
  const input = JSON.parse(readFileSync(file, "utf8")) as { offerName: string; notes?: string; facts: unknown };
  const facts = FactsSchema.parse(input.facts);
  const org = await db.organization.findFirst();
  if (!org) throw new Error("No organization in the database");

  const offer = (await db.offer.findFirst({ where: { orgId: org.id, name: input.offerName } }))
    ?? (await db.offer.create({ data: { orgId: org.id, name: input.offerName } }));
  const last = await db.offerVersion.findFirst({ where: { offerId: offer.id }, orderBy: { version: "desc" } });
  const v = await db.offerVersion.create({
    data: { offerId: offer.id, version: (last?.version ?? 0) + 1, status: "DRAFT", synthetic: false, facts, notes: input.notes ?? null },
  });
  console.log(`Draft v${v.version} of "${offer.name}" created with ${facts.length} facts. Open Knowledge on the site to review and publish.`);
}

main()
  .catch((e) => { console.error("LOAD FAILED:", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
