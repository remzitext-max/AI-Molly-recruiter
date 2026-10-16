import { redirect } from "next/navigation";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { config } from "@/lib/config";
import { createImportPreview } from "@/lib/import";
import { Card, fmt } from "@/components/ui";

async function upload(fd: FormData) {
  "use server";
  const u = await requireAdmin();
  const file = fd.get("file");
  if (!(file instanceof File) || !file.size) redirect("/import?error=Choose a file");
  if (file.size > 5 * 1024 * 1024) redirect("/import?error=File larger than 5 MB");
  const campaign = await db.campaign.findFirstOrThrow({ where: { id: String(fd.get("campaignId")), orgId: u.orgId } });
  let id: string;
  try {
    const b = await createImportPreview({ fileName: file.name, data: Buffer.from(await file.arrayBuffer()), campaignId: campaign.id, userId: u.id, orgId: u.orgId, isDemo: config.mode === "demo" || campaign.isDemo });
    id = b.id;
  } catch (e) {
    redirect(`/import?error=${encodeURIComponent((e as Error).message)}`);
  }
  redirect(`/import/${id}`);
}

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const u = await requireAdmin();
  const sp = await searchParams;
  const [campaigns, batches] = await Promise.all([
    db.campaign.findMany({ where: { orgId: u.orgId } }),
    db.importBatch.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  return (
    <>
      <h1>Import leads (CSV / XLSX)</h1>
      {sp.error && <div className="alert error">{sp.error}</div>}
      <Card>
        <form action={upload}>
          <label>File (.csv or .xlsx, max 5 MB, first sheet only)</label>
          <input type="file" name="file" accept=".csv,.xlsx" required />
          <label>Campaign</label>
          <select name="campaignId">{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}{c.isDemo ? " (demo)" : ""}</option>)}</select>
          <p className="small muted">Nothing is saved until you review the preview and confirm. Formulas are not evaluated and macros are rejected. {config.mode === "demo" && "In demo mode imported leads are marked as demo data."}</p>
          <button>Upload and preview</button>
        </form>
      </Card>
      <Card title="Google Sheets">
        <p>Import from your Google Sheet and keep new rows coming in automatically. <Link href="/sources/google-sheets">Open Google Sheets sync →</Link></p>
      </Card>
      <Card title="Recent imports">
        <table><thead><tr><th>When</th><th>File</th><th>Status</th><th>Result</th></tr></thead><tbody>
          {batches.map((b) => <tr key={b.id}><td className="small">{fmt(b.createdAt)}</td><td><Link href={`/import/${b.id}`}>{b.fileName}</Link></td><td>{b.status.toLowerCase()}</td><td className="small">{b.summary ? JSON.stringify(b.summary) : "—"}</td></tr>)}
        </tbody></table>
      </Card>
    </>
  );
}
