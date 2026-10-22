// Contact gate evaluated before EVERY call or message.
import type { Campaign, ContactPermission, Lead, SystemSetting } from "@prisma/client";
import { db } from "./db";
import { config } from "./config";
import { isWithinWindow, nextWindowStart, parseWindow } from "./timezone";

export type Channel = "CALL" | "SMS";
export type GateResult =
  | { ok: true }
  | { ok: false; code: string; message: string; retryAt?: Date; pipeline?: Lead["pipelineStatus"] };

export interface GateInput {
  lead: Lead & { permissions: ContactPermission[]; campaign: Campaign };
  settings: SystemSetting;
  channel: Channel;
  now: Date;
  /** SMS sent during a call after the driver verbally agreed. */
  verbalSmsConsent?: boolean;
}

export async function isSuppressed(phoneE164: string) {
  return !!(await db.suppression.findUnique({ where: { phoneE164 } }));
}

/** A driver who just applied is awake right now: the first call, its double dial, and the CDL text they agree to on it may skip the hours. Later retries keep to the hours. */
function isHotApplicant({ lead, channel, now, verbalSmsConsent }: GateInput) {
  const mins = lead.campaign.hotCallMinutes;
  if (!mins || lead.reengagedAt) return false;
  const age = now.getTime() - lead.createdAt.getTime();
  if (channel === "CALL") return lead.attemptCount === 0 ? age <= mins * 60_000 : lead.attemptCount === 1 && age <= (mins + 10) * 60_000;
  return !!verbalSmsConsent && age <= (mins + 60) * 60_000;
}

export async function evaluateContactGate(g: GateInput): Promise<GateResult> {
  const { lead, settings, channel, now } = g;
  if (lead.optedOutAt || (await isSuppressed(lead.phoneE164))) {
    return { ok: false, code: "OPTED_OUT", message: "Driver opted out / number suppressed", pipeline: "OPTED_OUT" };
  }
  if (config.mode === "live" && lead.isDemo) return { ok: false, code: "DEMO_RECORD", message: "Demo records cannot be contacted in live mode" };
  if (config.mode === "demo" && !lead.isDemo) return { ok: false, code: "LIVE_RECORD_IN_DEMO", message: "Live records are not contacted while the app runs in demo mode" };
  if (config.mode === "live") {
    if (!settings.contactPolicyConfirmedAt) return { ok: false, code: "POLICY_NOT_CONFIRMED", message: "Production contact disabled: contact policy not confirmed by an admin", retryAt: new Date(now.getTime() + 60 * 60_000) };
    if (!settings.liveContactEnabled) return { ok: false, code: "LIVE_DISABLED", message: "Production contact is switched off", retryAt: new Date(now.getTime() + 60 * 60_000) };
  }
  if (settings.globalPause) return { ok: false, code: "GLOBAL_PAUSE", message: "All outreach is paused", retryAt: new Date(now.getTime() + 15 * 60_000) };
  if (lead.campaign.paused) return { ok: false, code: "CAMPAIGN_PAUSE", message: `Campaign "${lead.campaign.name}" is paused`, retryAt: new Date(now.getTime() + 15 * 60_000) };

  const active = (scope: string) => lead.permissions.some((p) => p.scope === scope && !p.revokedAt && p.grantedAt <= now);
  if (channel === "CALL" && settings.requireCallPermission && !active("AI_CALL")) {
    return { ok: false, code: "NO_PERMISSION", message: "No recorded permission for automated AI calls", pipeline: "NEEDS_PERMISSION" };
  }
  if (channel === "SMS" && settings.requireSmsPermission && !active("SMS") && !(g.verbalSmsConsent && settings.allowVerbalSmsConsent)) {
    return { ok: false, code: "NO_SMS_PERMISSION", message: "No recorded permission for text messages" };
  }
  // A hot applicant's first call ignores hours, so it does not need their timezone either.
  if (!lead.timezone && !isHotApplicant(g)) return { ok: false, code: "NO_TIMEZONE", message: "Driver timezone unknown; resolve before automatic contact", pipeline: "NEEDS_TIMEZONE" };

  const w = parseWindow(lead.campaign.contactWindowStart, lead.campaign.contactWindowEnd, lead.campaign.contactDays);
  if (lead.timezone && !isWithinWindow(now, lead.timezone, w) && !isHotApplicant(g)) {
    return { ok: false, code: "OUTSIDE_HOURS", message: "Outside permitted driver-local contact hours", retryAt: nextWindowStart(now, lead.timezone, w) };
  }
  if (channel === "CALL" && lead.attemptCount >= lead.campaign.maxAttempts) {
    return { ok: false, code: "MAX_ATTEMPTS", message: `Reached ${lead.campaign.maxAttempts} call attempts` };
  }
  return { ok: true };
}
