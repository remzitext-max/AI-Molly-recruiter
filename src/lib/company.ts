import { db } from "./db";

/** The name drivers hear and read. Recruiting teams call and text in their own company name
 *  when one is set on the Teams page, otherwise in the main company's name. */
export async function companyName(org: { name: string; isMain: boolean; companyName?: string | null }) {
  if (org.isMain) return org.name;
  if (org.companyName?.trim()) return org.companyName.trim();
  return (await db.organization.findFirst({ where: { isMain: true }, orderBy: { createdAt: "asc" }, select: { name: true } }))?.name ?? org.name;
}
