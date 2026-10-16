import { NextResponse } from "next/server";
import { handleInboundSms } from "@/lib/messaging";
import { normalizePhone } from "@/lib/phone";
import { safeEqual } from "@/lib/crypto";

// RingCentral webhook subscription for inbound SMS
// (eventFilters: /restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS).
// Creation handshake: echo the Validation-Token header. Each delivery carries the
// Verification-Token we set when creating the subscription.
export async function POST(req: Request) {
  const validation = req.headers.get("validation-token");
  if (validation) return new NextResponse(null, { status: 200, headers: { "Validation-Token": validation } });
  const expected = process.env.RINGCENTRAL_WEBHOOK_VERIFICATION_TOKEN;
  const got = req.headers.get("verification-token") ?? "";
  if (!expected || !safeEqual(expected, got)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const j = (await req.json().catch(() => null)) as { body?: { id?: string | number; direction?: string; from?: { phoneNumber?: string }; subject?: string } } | null;
  const b = j?.body;
  if (!b?.id || b.direction !== "Inbound") return NextResponse.json({ ignored: true });
  const from = normalizePhone(b.from?.phoneNumber);
  if (!from) return NextResponse.json({ ignored: true });
  await handleInboundSms(from, String(b.subject ?? ""), `rc_${b.id}`, "ringcentral");
  return NextResponse.json({ ok: true });
}
