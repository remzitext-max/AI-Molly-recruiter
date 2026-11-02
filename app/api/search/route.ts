import { apiUser } from "@/lib/api-guard";
import { db } from "@/lib/db";
import { readScope } from "@/lib/rbac";
import { isDemo } from "@/lib/config";

// Drivers matching what is being typed in the top search box, for the suggestions under it.
export async function GET(req: Request) {
  const u = await apiUser(req);
  if (u instanceof Response) return u;
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 60);
  if (q.length < 2) return Response.json({ results: [] });
  const digits = q.replace(/\D/g, "");
  const words = q.split(/\s+/).filter(Boolean).slice(0, 3);
  // Every word has to match the first or last name ("carl lub" finds Carl Lubin).
  const byName = { AND: words.map((w) => ({ OR: [{ firstName: { contains: w, mode: "insensitive" as const } }, { lastName: { contains: w, mode: "insensitive" as const } }] })) };
  const leads = await db.lead.findMany({
    where: { ...(await readScope(u)), isDemo: isDemo(), OR: [byName, ...(digits.length >= 3 ? [{ phoneE164: { contains: digits } }] : [])] },
    orderBy: { createdAt: "desc" }, take: 8,
    select: { id: true, firstName: true, lastName: true, phoneE164: true, state: true, recruiterStatus: true, pipelineStatus: true, org: { select: { name: true, isMain: true } }, assignedTo: { select: { name: true } } },
  });
  return Response.json({
    results: leads.map((l) => ({
      id: l.id, name: [l.firstName, l.lastName].filter(Boolean).join(" ") || "(no name)", phone: l.phoneE164, state: l.state,
      status: l.recruiterStatus ?? l.pipelineStatus.replace(/_/g, " ").toLowerCase(), recruiter: l.assignedTo?.name ?? null,
      team: l.org.isMain ? null : l.org.name,
    })),
  }, { headers: { "Cache-Control": "private, no-store" } });
}
