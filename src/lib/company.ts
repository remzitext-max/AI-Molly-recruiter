import { db } from "./db";

/** The name drivers hear and read. Recruiting teams on the site call and text in the company's name. */
export async function companyName(org: { name: string; isMain: boolean }) {
  if (org.isMain) return org.name;
  return (await db.organization.findFirst({ where: { isMain: true }, orderBy: { createdAt: "asc" }, select: { name: true } }))?.name ?? org.name;
}
