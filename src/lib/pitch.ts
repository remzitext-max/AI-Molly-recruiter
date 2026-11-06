// The company-specific sales pitch Crystal says on calls. It lives on the organization (Teams
// page) so another carrier gets its own offer without touching the shared prompt; a recruiting
// team with no pitch of its own uses the main company's, and the main company falls back to
// TBT express's original wording.
import { db } from "./db";

export interface Pitch {
  /** Step 3: the opening offer, ending in a question. */
  hook: string;
  /** Step 4: what the driver can earn, said after they answer the hook. */
  earnings: string;
  /** Minimum experience for the main (solo) position, e.g. "2 years". */
  soloMinExperience: string;
  /** What team drivers are paid, e.g. "$1 to $1.10 per mile". */
  teamPay: string;
  /** Trailer / equipment, e.g. "dry van". */
  equipment: string;
  /** Extra company rules, one per line (e.g. the camera rule). */
  rules: string;
}

export const PITCH_KEYS = ["hook", "earnings", "soloMinExperience", "teamPay", "equipment", "rules"] as const;

export const DEFAULT_PITCH: Pitch = {
  hook: "And I've got great news! Right now we're offering up to 85 cents per mile for solo drivers, dry van, with a driver-facing camera in the truck. In our company we usually cover around 3,500 miles a week, so may I ask, how many miles can you cover on a weekly basis?",
  earnings: "So if you drive 3,500 to 4,000 miles a week, you'd be able to make around $3,000 to $3,500 a week with us.",
  soloMinExperience: "2 years",
  teamPay: "$1 to $1.10 per mile",
  equipment: "dry van",
  rules: [
    "Whenever you mention 85 cents per mile, say it comes with a driver-facing camera in the truck. Never offer 85 cents without the camera.",
    "If the driver says they don't want the driver-facing camera, never argue or push. Say exactly: \"Okay, let me talk with my manager, he will call you shortly.\" Save it with record_screening_answer, key concerns, value \"Doesn't want driver-facing camera\". Do not bring up the camera again; carry on with the next question.",
  ].join("\n"),
};

/** Keeps only known, non-empty text fields (trimmed, length-capped). */
export function cleanPitch(raw: unknown): Partial<Pitch> {
  const out: Partial<Pitch> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of PITCH_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, k === "rules" ? 2000 : 600);
  }
  return out;
}

/** The pitch for an organization: its own fields, then the main company's, then the default. */
export async function pitchFor(org: { isMain: boolean; pitch?: unknown }): Promise<Pitch> {
  const own = cleanPitch(org.pitch);
  const main = org.isMain ? {} : cleanPitch((await db.organization.findFirst({ where: { isMain: true }, orderBy: { createdAt: "asc" }, select: { pitch: true } }))?.pitch);
  return { ...DEFAULT_PITCH, ...main, ...own };
}

/** Per-call prompt variables ({{pitch_hook}} and so on). */
export function pitchVariables(p: Pitch): Record<string, string> {
  return {
    pitch_hook: p.hook, pitch_earnings: p.earnings, solo_min_experience: p.soloMinExperience,
    team_pay: p.teamPay, equipment: p.equipment,
    company_rules: p.rules.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => `- ${l}`).join("\n"),
  };
}
