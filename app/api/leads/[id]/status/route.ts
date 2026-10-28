import { apiUser } from "@/lib/api-guard";
import { db } from "@/lib/db";
import { leadScope } from "@/lib/rbac";
import { setRecruiterStatus } from "@/lib/recruiter-status";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await apiUser(req);
  if (u instanceof Response) return u;
  const { id } = await params;
  if (!(await db.lead.findFirst({ where: { id, ...leadScope(u) }, select: { id: true } }))) return new Response("Not found", { status: 404 });
  const { status } = ((await req.json().catch(() => ({}))) ?? {}) as { status?: string };
  try {
    return Response.json(await setRecruiterStatus(id, String(status ?? ""), { id: u.id, name: u.name }));
  } catch (e) {
    return new Response((e as Error).message, { status: 400 });
  }
}
