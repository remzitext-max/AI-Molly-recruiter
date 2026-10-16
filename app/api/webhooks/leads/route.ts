import { NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { verifySignature } from "@/lib/webhook-auth";
import { ingestLead } from "@/lib/leads";

// Signed lead intake for any other upstream system. Idempotent on (sourceSystem, sourceRecordId).
const Lead = z.object({
  sourceSystem: z.string().min(1).max(40), sourceRecordId: z.string().min(1).max(200),
  firstName: z.string().max(80).optional(), lastName: z.string().max(80).optional(), phone: z.string().min(7).max(30),
  email: z.string().max(200).optional(), state: z.string().max(2).optional(), zip: z.string().max(10).optional(),
  campaignId: z.string().max(40).optional(),
  permission: z.array(z.object({ scope: z.enum(["AI_CALL", "SMS"]), source: z.string().min(1).max(300), grantedAt: z.string().datetime(), evidence: z.string().max(1000).optional() })).max(5).optional(),
});

export async function POST(req: Request) {
  const raw = await req.text();
  const v = verifySignature(config.leadWebhookSecret, raw, req.headers.get("x-molly-signature"));
  if (!v.ok) return NextResponse.json({ error: v.reason }, { status: 401 });
  const p = Lead.safeParse(JSON.parse(raw));
  if (!p.success) return NextResponse.json({ error: p.error.issues.map((i) => i.message) }, { status: 400 });
  const isDemo = config.mode === "demo";
  const campaign = await db.campaign.findFirst({ where: p.data.campaignId ? { id: p.data.campaignId } : { isDemo } });
  if (!campaign) return NextResponse.json({ error: "No campaign" }, { status: 400 });
  const r = await ingestLead({ ...p.data, raw: { via: "webhook" } }, { orgId: campaign.orgId, campaignId: campaign.id, isDemo: isDemo || campaign.isDemo });
  return NextResponse.json(r, { status: r.result === "invalid" ? 400 : 200 });
}
