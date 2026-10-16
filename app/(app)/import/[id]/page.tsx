import { redirect } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { commitBatch, previewBatch, SHEETS_SOURCE, TARGET_FIELDS } from "@/lib/import";
import { getAdapters } from "@/adapters/registry";
import { Badge, Card } from "@/components/ui";

async function remap(fd: FormData) {
  "use server";
  await requireAdmin();
  const id = String(fd.get("batchId"));
  const mapping: Record<string, string> = {};
  for (const f of TARGET_FIELDS) { const v = String(fd.get(`map_${f}`) ?? ""); if (v) mapping[f] = v; }
  // Google Sheets rows are always identified by the configured ID column.
  const b = await db.importBatch.findUniqueOrThrow({ where: { id } });
  if (b.sourceSystem === SHEETS_SOURCE && getAdapters().sheets.idColumn) mapping.sourceRecordId = getAdapters().sheets.idColumn!;
  await db.importBatch.update({ where: { id, status: "PREVIEW" } as Prisma.ImportBatchWhereUniqueInput, data: { mapping } });
  redirect(`/import/${id}`);
}

async function commit(fd: FormData) {
  "use server";
  const u = await requireAdmin();
  const id = String(fd.get("batchId"));
  await commitBatch(id, u);
  redirect(`/import/${id}`);
}

async function discard(fd: FormData) {
  "use server";
  await requireAdmin();
  await db.importBatch.updateMany({ where: { id: String(fd.get("batchId")), status: "PREVIEW" }, data: { status: "DISCARDED" } });
  redirect("/import");
}

export default async function Preview({ params }: { params: Promise<{ id: string }> }) {
  const u = await requireAdmin();
  const { id } = await params;
  const { batch, headers, warnings, preview } = await previewBatch(id, u.orgId);
  const mapping = batch.mapping as Record<string, string>;
  const counts = preview.reduce<Record<string, number>>((a, r) => { a[r.disposition] = (a[r.disposition] ?? 0) + 1; return a; }, {});
  const editable = batch.status === "PREVIEW";
  return (
    <>
      <h1>Import: {batch.fileName}</h1>
      {batch.summary && <div className="alert ok">Committed: {JSON.stringify(batch.summary)}</div>}
      {warnings.map((w, i) => <div key={i} className="alert warn">{w}</div>)}
      <Card title="Column mapping">
        <form action={remap}>
          <input type="hidden" name="batchId" value={batch.id} />
          <div className="grid three">
            {TARGET_FIELDS.map((f) => (
              <div key={f}><label>{f}</label>
                <select name={`map_${f}`} defaultValue={mapping[f] ?? ""} disabled={!editable || (f === "sourceRecordId" && batch.sourceSystem === SHEETS_SOURCE)}><option value="">— not mapped —</option>{headers.map((h) => <option key={h}>{h}</option>)}</select>
              </div>
            ))}
          </div>
          <p className="small muted">{batch.sourceSystem === SHEETS_SOURCE
            ? <>Google Sheets rows are identified by the &ldquo;{mapping.sourceRecordId}&rdquo; column, or by phone number when the ID is empty. Importing saves this mapping for automatic syncs.</>
            : "Identity uses the source ID column when mapped, otherwise the normalized phone number; row numbers are never used."}</p>
          {editable && <button className="secondary">Update preview</button>}
        </form>
      </Card>
      <Card title="Preview" right={<span className="small">{Object.entries(counts).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(" · ")}</span>}>
        <table>
          <thead><tr><th>Row</th><th>Name</th><th>Phone</th><th>State/ZIP</th><th>Result</th><th>Errors / warnings</th></tr></thead>
          <tbody>
            {preview.slice(0, 300).map((r) => (
              <tr key={r.rowNumber}>
                <td>{r.rowNumber}</td><td>{[r.values.firstName, r.values.lastName].filter(Boolean).join(" ")}</td>
                <td className="small">{r.phoneE164 ?? r.values.phone}</td><td className="small">{r.values.state} {r.values.zip}</td>
                <td><Badge v={r.disposition} tone={r.disposition === "new" ? "ok" : r.disposition === "error" ? "bad" : "warn"} /></td>
                <td className="small">{r.errors.map((e) => <div key={e} style={{ color: "var(--bad)" }}>{e}</div>)}{r.warnings.map((w) => <div key={w} className="muted">{w}</div>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {preview.length > 300 && <p className="muted">Showing first 300 of {preview.length} rows.</p>}
        {editable && (
          <div className="row" style={{ marginTop: 12 }}>
            <form action={commit}><input type="hidden" name="batchId" value={batch.id} /><button>Import {(counts.new ?? 0) + (counts.merge_existing_phone ?? 0) + (counts.suppressed ?? 0)} valid rows</button></form>
            <form action={discard}><input type="hidden" name="batchId" value={batch.id} /><button className="secondary">Discard</button></form>
          </div>
        )}
      </Card>
    </>
  );
}
