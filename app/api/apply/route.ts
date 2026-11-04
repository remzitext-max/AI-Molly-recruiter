import { NextResponse } from "next/server";
import { parseAdLead } from "@/lib/ad-leads";
import { acceptAdLead } from "@/lib/ad-leads-intake";

// Public application form behind YouTube / TikTok ads (/apply?src=youtube|tiktok).
// Spam guards: hidden honeypot field, required consent, a few submissions per IP per hour.
const hits = new Map<string, number[]>();
const LIMIT = 5;

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= LIMIT) return NextResponse.json({ error: "Too many tries. Please call us instead." }, { status: 429 });
  hits.set(ip, [...recent, now]);

  let b: Record<string, string>;
  try { b = await req.json(); } catch { return NextResponse.json({ error: "Bad form" }, { status: 400 }); }
  if (b.website) return NextResponse.json({ ok: true }); // honeypot: bots fill every field
  if (b.consent !== "yes") return NextResponse.json({ error: "Please check the box so we can call you." }, { status: 400 });
  const src = b.src === "tiktok" ? "tiktok" : "google";
  const { consent: _c, website: _w, src: _s, ...fields } = b;
  const p = parseAdLead({ ...fields, campaign: b.campaign || (src === "tiktok" ? "TikTok" : "YouTube"), ad: b.ad || "apply page" }, src);
  if ("error" in p) return NextResponse.json({ error: "Please enter a valid phone number." }, { status: 400 });
  (p.lead.raw as Record<string, unknown>).via = `${src === "tiktok" ? "tiktok" : "youtube"}_apply_page`;
  (p.lead.raw as Record<string, unknown>).consent = { at: new Date().toISOString(), ip, text: "apply page call/text consent" };
  const r = await acceptAdLead(p);
  if (r.result === "invalid") return NextResponse.json({ error: "Please enter a valid phone number." }, { status: 400 });
  return NextResponse.json({ ok: true });
}
