import { currentUser } from "@/lib/auth";
import { readDocumentForUser } from "@/lib/documents";
import { ForbiddenError } from "@/lib/rbac";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const u = await currentUser();
  if (!u) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  try {
    const { doc, data } = await readDocumentForUser(u, id);
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": doc.mimeType, "Cache-Control": "private, no-store", "Content-Disposition": `inline; filename="cdl-${doc.id}"`,
        "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      },
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return new Response("Not found", { status: 404 });
    throw e;
  }
}
