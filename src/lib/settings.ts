import { db } from "./db";

export async function getSettings() {
  return db.systemSetting.upsert({ where: { id: "global" }, create: { id: "global" }, update: {} });
}

/**
 * The call opening is the owner's choice of wording, with two fixed limits:
 * it must name the company (identification at the start of an artificial-voice
 * call), and it may never claim the caller is a person. Whatever the opening
 * says, the agent always answers truthfully when asked whether it is an AI.
 */
export function validateOpening(text: string): string | null {
  if (!text.includes("{company}")) return "The opening must name the company: include {company}.";
  if (/\b(real person|a human|not an? (ai|robot|bot|machine|computer|recording)|live person)\b/i.test(text)) return "The opening may not claim the caller is a person.";
  return null;
}
