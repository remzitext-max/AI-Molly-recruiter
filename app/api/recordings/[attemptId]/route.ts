import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertLeadAccess, ForbiddenError } from "@/lib/rbac";
import { getAdapters } from "@/adapters/registry";
import { recordingMime } from "@/lib/recordings";

// Plays a call recording for a signed-in user who can see the lead.
export async function GET(_req: Request, { params }: { params: Promise<{ attemptId: string }> }) {
  const u = await currentUser();
  if (!u) return new Response("Unauthorized", { status: 401 });
  const { attemptId } = await params;
  const a = await db.callAttempt.findUnique({ where: { id: attemptId }, select: { leadId: true, recordingKey: true } });
  if (!a?.recordingKey) return new Response("Not found", { status: 404 });
  try {
    await assertLeadAccess(u, a.leadId);
  } catch (e) {
    if (e instanceof ForbiddenError) return new Response("Not found", { status: 404 });
    throw e;
  }
  const data = await getAdapters().storage.get(a.recordingKey);
  return new Response(new Uint8Array(data), {
    headers: { "Content-Type": recordingMime(a.recordingKey), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}
