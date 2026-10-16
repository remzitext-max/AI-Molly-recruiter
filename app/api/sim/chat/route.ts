import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { FactsSchema } from "@/lib/knowledge";
import { RecruitingBrain, type BrainState, type DriverInput } from "@/lib/conversation/brain";

// Text sandbox for admins. Stateless: the brain state round-trips through the
// browser and nothing is persisted or sent anywhere.
export async function POST(req: Request) {
  const u = await currentUser();
  if (!u || u.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { state: BrainState | null; input: { type: string; text?: string } } | null;
  if (!body?.input) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const settings = await getSettings();
  const org = await db.organization.findUniqueOrThrow({ where: { id: u.orgId } });
  const campaign = await db.campaign.findFirst({ where: { orgId: u.orgId, offerId: { not: null } }, include: { offer: true } });
  const v = campaign?.offer?.activeVersionId ? await db.offerVersion.findUnique({ where: { id: campaign.offer.activeVersionId } }) : null;
  const facts = v ? FactsSchema.parse(v.facts) : [];
  const fill = (s: string) => s.replace(/\{company\}/g, org.name).replace(/\{recruiterPhone\}/g, "our office");
  const brain = new RecruitingBrain({
    companyName: org.name, recruiterName: "Molly", driverFirstName: "Marcus", driverTimezone: "America/Chicago", facts,
    disclosure: fill(settings.aiDisclosure), recordingNotice: settings.recordingEnabled ? settings.recordingNotice : null,
    voicemailMessage: fill(settings.voicemailMessage), uploadLinkTtlMinutes: settings.uploadLinkTtlMinutes,
  }, body.input.type === "start" ? undefined : body.state ?? undefined);
  const t0 = performance.now();
  const input: DriverInput = body.input.type === "silence" ? { type: "silence" } : body.input.type === "voicemail" ? { type: "voicemail" } : { type: "speech", text: String(body.input.text ?? "").slice(0, 1000) };
  const turn = body.input.type === "start" ? brain.start() : brain.handle(input);
  return NextResponse.json({ ...turn, state: brain.state, latencyMs: Math.round((performance.now() - t0) * 100) / 100 });
}
