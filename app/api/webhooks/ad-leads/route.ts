import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { safeEqual } from "@/lib/crypto";
import { ingestLead } from "@/lib/leads";
import { recordEvent } from "@/lib/activity";
import { parseAdLead } from "@/lib/ad-leads";

// Lead intake for YouTube (Google Ads lead form webhook) and TikTok (via Make/Zapier).
// URL: /api/webhooks/ad-leads?platform=google|tiktok[&key=...]; Google sends the key as google_key.
export async function POST(req: Request) {
  const url = new URL(req.url);
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Body must be JSON" }, { status: 400 }); }
  const p = parseAdLead(body, url.searchParams.get("platform") ?? undefined);
  const secret = config.adLeadsKey;
  const given = ("key" in p ? p.key : undefined) ?? url.searchParams.get("key") ?? "";
  if (!secret || !given || !safeEqual(given, secret)) return NextResponse.json({ error: "Bad key" }, { status: 401 });
  if ("error" in p) return NextResponse.json({ error: p.error }, { status: 400 });
  // Google's "Send test data" button: accept it so the form setup passes, but create nothing.
  if (p.isTest) return NextResponse.json({ result: "test_ok" });

  const isDemo = config.mode === "demo";
  const campaign = await db.campaign.findFirst({ where: config.adLeadsCampaignId ? { id: config.adLeadsCampaignId } : { isDemo }, orderBy: { createdAt: "asc" } });
  if (!campaign) return NextResponse.json({ error: "No campaign" }, { status: 400 });
  const r = await ingestLead(p.lead, { orgId: campaign.orgId, campaignId: campaign.id, isDemo: isDemo || campaign.isDemo, scheduleOutreach: !p.sapYes });
  if (r.result === "created" && p.sapYes) await recordEvent({ leadId: r.leadId, actorType: "SYSTEM", type: "NOTE", message: "Answered yes to SAP on the ad form; no automatic call" });
  return NextResponse.json(r, { status: r.result === "invalid" ? 400 : 200 });
}
