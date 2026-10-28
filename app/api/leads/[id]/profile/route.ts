import { currentUser } from "@/lib/auth";
import { loadDriverProfile } from "@/lib/driver-profile";

// The driver's profile for the Leads popup, for a signed-in user who can see the lead.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return new Response("Unauthorized", { status: 401 });
  const p = await loadDriverProfile(u, (await params).id);
  if (!p) return new Response("Not found", { status: 404 });
  return Response.json(p, { headers: { "Cache-Control": "private, no-store" } });
}
