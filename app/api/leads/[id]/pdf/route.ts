import { currentUser } from "@/lib/auth";
import { loadDriverProfile } from "@/lib/driver-profile";
import { profilePdf, pdfFileName } from "@/lib/profile-pdf";

// The driver's profile as a PDF download.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return new Response("Unauthorized", { status: 401 });
  const p = await loadDriverProfile(u, (await params).id);
  if (!p) return new Response("Not found", { status: 404 });
  const bytes = await profilePdf(p, u.name);
  return new Response(new Uint8Array(bytes), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${pdfFileName(p)}"`, "Cache-Control": "private, no-store" },
  });
}
