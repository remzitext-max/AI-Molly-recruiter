import { NextResponse } from "next/server";
import { finishUpload, handleUpload, UploadError } from "@/lib/documents";

// Public endpoint protected only by the short-lived unguessable token.
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > 26 * 1024 * 1024) return NextResponse.json({ error: "File is too large." }, { status: 413 });
  const fd = await req.formData().catch(() => null);
  if (!fd) return NextResponse.json({ error: "Bad upload" }, { status: 400 });
  if (fd.get("finish")) { await finishUpload(token); return NextResponse.json({ ok: true }); }
  const f = fd.get("file");
  if (!(f instanceof File)) return NextResponse.json({ error: "Choose a photo or PDF of your CDL." }, { status: 400 });
  try {
    await handleUpload(token, { data: Buffer.from(await f.arrayBuffer()), declaredType: f.type, name: f.name });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof UploadError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: "Upload failed. Please try again." }, { status: 500 });
  }
}
