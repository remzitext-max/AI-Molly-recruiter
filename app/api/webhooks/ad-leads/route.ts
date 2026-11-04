import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { safeEqual } from "@/lib/crypto";
import { parseAdLead } from "@/lib/ad-leads";
import { acceptAdLead } from "@/lib/ad-leads-intake";

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
  const r = await acceptAdLead(p);
  if (r.result === "no_campaign") return NextResponse.json({ error: "No campaign" }, { status: 400 });
  return NextResponse.json(r, { status: r.result === "invalid" ? 400 : 200 });
}
