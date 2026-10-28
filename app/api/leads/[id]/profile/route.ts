import { apiUser } from "@/lib/api-guard";
import { db } from "@/lib/db";
import { loadDriverProfile, saveProfileEdits } from "@/lib/driver-profile";
import { RECRUITER_STATUSES } from "@/lib/recruiter-status";

async function withOptions(u: { orgId: string }, p: NonNullable<Awaited<ReturnType<typeof loadDriverProfile>>>) {
  const recruiters = await db.user.findMany({ where: { orgId: u.orgId, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  return Response.json({ ...p, options: { statuses: RECRUITER_STATUSES, recruiters } }, { headers: { "Cache-Control": "private, no-store" } });
}

// The driver's profile for the Leads popup, for a signed-in user who can see the lead.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await apiUser(req);
  if (u instanceof Response) return u;
  const p = await loadDriverProfile(u, (await params).id);
  if (!p) return new Response("Not found", { status: 404 });
  return withOptions(u, p);
}

// A recruiter's corrections from the popup's Edit form.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await apiUser(req);
  if (u instanceof Response) return u;
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { values?: Record<string, unknown> } | null;
  if (!body?.values || typeof body.values !== "object") return new Response("Bad request", { status: 400 });
  if (!(await saveProfileEdits(u, id, body.values))) return new Response("Not found", { status: 404 });
  return withOptions(u, (await loadDriverProfile(u, id))!);
}
