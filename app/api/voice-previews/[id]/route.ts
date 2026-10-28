import { currentUser, isOwner } from "@/lib/auth";
import { db } from "@/lib/db";
import { getAdapters } from "@/adapters/registry";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u || !(await isOwner(u))) return new Response("Forbidden", { status: 403 });
  const { id } = await params;
  const p = await db.voicePreview.findUnique({ where: { id } });
  if (!p?.audioKey) return new Response("Not found", { status: 404 });
  const data = await getAdapters().storage.get(p.audioKey);
  return new Response(new Uint8Array(data), { headers: { "Content-Type": "audio/wav", "Cache-Control": "private, no-store" } });
}
