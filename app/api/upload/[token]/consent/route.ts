import { NextResponse } from "next/server";
import { saveRecordCheckConsent, UploadError } from "@/lib/documents";

// Public endpoint protected only by the short-lived unguessable upload token.
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const fd = await req.formData().catch(() => null);
  if (!fd || fd.get("agree") !== "on") return NextResponse.json({ error: "Tick the box to agree." }, { status: 400 });
  try {
    await saveRecordCheckConsent(token, {
      fullName: String(fd.get("fullName") ?? ""),
      ip: req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null,
      userAgent: req.headers.get("user-agent"),
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof UploadError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: "Could not save. Please try again." }, { status: 500 });
  }
}
