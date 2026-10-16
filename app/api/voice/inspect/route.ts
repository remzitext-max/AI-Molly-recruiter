import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { inspectAudio } from "@/lib/audio-inspect";

export async function POST(req: Request) {
  const u = await currentUser();
  if (!u || u.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const fd = await req.formData();
  const f = fd.get("recording");
  if (!(f instanceof File) || !f.size) return NextResponse.json({ error: "No file" }, { status: 400 });
  if (f.size > 200 * 1024 * 1024) return NextResponse.json({ error: "File too large" }, { status: 413 });
  return NextResponse.json(inspectAudio(Buffer.from(await f.arrayBuffer()), f.name));
}
