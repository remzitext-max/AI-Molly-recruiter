// Creates recruiter logins for a team in one go, each tied to their tab of the team's lead sheet.
// Run on the server:
//   docker compose exec web npx tsx scripts/add-recruiters.ts "First team" Sora Samuel Freya
// Prints each login email and a temporary password; logins that already exist are left alone.
import crypto from "node:crypto";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth";
import { recordEvent } from "../src/lib/activity";
import { assignFromSheetTabs } from "../src/lib/assignment";

async function main() {
  const [teamName, ...names] = process.argv.slice(2);
  if (!teamName || !names.length) throw new Error('Usage: npx tsx scripts/add-recruiters.ts "First team" Sora Samuel ...');
  const org = await db.organization.findFirst({ where: { name: { equals: teamName, mode: "insensitive" } } });
  if (!org) throw new Error(`No team called "${teamName}" (see the Teams page)`);
  const domain = `${org.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.local`;
  console.log(`Team ${org.name}. Give each recruiter their login; they sign in at the site's address.`);
  for (const raw of names) {
    const name = raw.trim();
    const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}@${domain}`;
    if (await db.user.findUnique({ where: { email } })) { console.log(`${name}: ${email} already exists, left alone`); continue; }
    const password = crypto.randomBytes(9).toString("base64url"); // 12 characters
    await db.user.create({ data: { orgId: org.id, email, name, role: "RECRUITER", passwordHash: await hashPassword(password), sheetTab: name, inRoundRobin: true } });
    await recordEvent({ actorType: "SYSTEM", orgId: org.id, type: "USER_CREATED", message: `User ${email} created (sheet tab ${name})` });
    // Drivers already in their tab are theirs on the site too.
    const rows = await db.sheetLeadStatus.findMany({ where: { tab: { equals: name, mode: "insensitive" } }, select: { phoneE164: true, tab: true } });
    const claimed = await assignFromSheetTabs(rows);
    console.log(`${name}: login ${email}  password ${password}${claimed ? `  (${claimed} leads from the ${name} tab)` : ""}`);
  }
}

main()
  .then(() => console.log("Done"))
  .catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
