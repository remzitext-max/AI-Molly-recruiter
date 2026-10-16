import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { FACT_CATEGORIES, FactsSchema, type Fact } from "@/lib/knowledge";
import { recordEvent } from "@/lib/activity";
import { Badge, Card } from "@/components/ui";

function readFacts(fd: FormData): Fact[] {
  const out: Fact[] = [];
  for (let i = 0; i < 200; i++) {
    if (!fd.has(`f${i}_key`)) break;
    const key = String(fd.get(`f${i}_key`) || "").trim();
    if (!key || fd.get(`f${i}_remove`)) continue;
    out.push({
      key, category: String(fd.get(`f${i}_category`)) as Fact["category"], title: String(fd.get(`f${i}_title`) || key).trim(),
      content: String(fd.get(`f${i}_content`) || "").trim(),
      keywords: String(fd.get(`f${i}_keywords`) || "").split(",").map((s) => s.trim()).filter(Boolean),
      confirmed: fd.get(`f${i}_confirmed`) === "on",
    });
  }
  return out;
}

async function save(fd: FormData) {
  "use server";
  const u = await requireAdmin();
  const id = String(fd.get("versionId"));
  const v = await db.offerVersion.findUniqueOrThrow({ where: { id }, include: { offer: true } });
  if (v.status !== "DRAFT" || v.offer.orgId !== u.orgId) throw new Error("Only drafts can be edited");
  const parsed = FactsSchema.safeParse(readFacts(fd));
  if (!parsed.success) redirect(`/knowledge/${id}?error=${encodeURIComponent(parsed.error.issues.map((i) => i.message).join("; "))}`);
  await db.offerVersion.update({ where: { id }, data: { facts: parsed.data, synthetic: fd.get("synthetic") === "on", notes: String(fd.get("notes") || "") || null } });
  if (fd.get("publish")) {
    if (!parsed.data.length) redirect(`/knowledge/${id}?error=Add at least one fact before publishing`);
    if (fd.get("synthetic") !== "on" && fd.get("attest") !== "on") redirect(`/knowledge/${id}?error=Confirm the facts are approved before publishing real data`);
    await db.$transaction([
      db.offerVersion.updateMany({ where: { offerId: v.offerId, status: "PUBLISHED" }, data: { status: "ARCHIVED" } }),
      db.offerVersion.update({ where: { id }, data: { status: "PUBLISHED", publishedAt: new Date() } }),
      db.offer.update({ where: { id: v.offerId }, data: { activeVersionId: id } }),
    ]);
    await recordEvent({ actorType: "USER", actorId: u.id, orgId: u.orgId, type: "OFFER_PUBLISHED", message: `Published "${v.offer.name}" v${v.version}` });
  }
  redirect(`/knowledge/${id}?saved=1`);
}

export default async function VersionPage({ params, searchParams }: { params: Promise<{ versionId: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  const u = await requireAdmin();
  const { versionId } = await params;
  const sp = await searchParams;
  const v = await db.offerVersion.findUnique({ where: { id: versionId }, include: { offer: true } });
  if (!v || v.offer.orgId !== u.orgId) notFound();
  const facts = (v.facts as Fact[]) ?? [];
  const editable = v.status === "DRAFT";
  const rows: (Fact | null)[] = editable ? [...facts, null, null, null] : facts;
  return (
    <>
      <h1>{v.offer.name} · v{v.version} <Badge v={v.status} /> {v.synthetic && <Badge v="SYNTHETIC" tone="demo" />}</h1>
      {sp.error && <div className="alert error">{sp.error}</div>}
      {sp.saved && <div className="alert ok">Saved.</div>}
      {!editable && <div className="alert warn">Published and archived versions are read-only so call records stay accurate. Create a new draft to change facts.</div>}
      <form action={save}>
        <input type="hidden" name="versionId" value={v.id} />
        <Card>
          <p className="small muted">Content is the exact wording the assistant may say. Keep it short and factual. Never include guarantees you cannot honor. Uncheck “confirmed” for anything still pending: the assistant will defer to Molly.</p>
          <table>
            <thead><tr><th>Key</th><th>Category</th><th>Title</th><th>Approved wording</th><th>Match keywords</th><th>Confirmed</th>{editable && <th>Remove</th>}</tr></thead>
            <tbody>
              {rows.map((f, i) => (
                <tr key={i}>
                  <td><input name={`f${i}_key`} defaultValue={f?.key ?? ""} placeholder="pay.cpm" size={14} disabled={!editable} /></td>
                  <td><select name={`f${i}_category`} defaultValue={f?.category ?? "faq"} disabled={!editable}>{FACT_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></td>
                  <td><input name={`f${i}_title`} defaultValue={f?.title ?? ""} size={14} disabled={!editable} /></td>
                  <td style={{ minWidth: 300 }}><textarea name={`f${i}_content`} defaultValue={f?.content ?? ""} rows={2} disabled={!editable} /></td>
                  <td><input name={`f${i}_keywords`} defaultValue={f?.keywords.join(", ") ?? ""} size={16} disabled={!editable} /></td>
                  <td><input type="checkbox" name={`f${i}_confirmed`} defaultChecked={f ? f.confirmed : true} disabled={!editable} /></td>
                  {editable && <td><input type="checkbox" name={`f${i}_remove`} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
          {editable && <p className="small muted">Three blank rows are added each time you save.</p>}
          <label>Notes</label><textarea name="notes" rows={2} defaultValue={v.notes ?? ""} disabled={!editable} />
          <div className="row" style={{ marginTop: 8 }}>
            <label style={{ margin: 0 }}><input type="checkbox" name="synthetic" defaultChecked={v.synthetic} disabled={!editable} /> Synthetic demo facts (live calls refuse synthetic offers)</label>
          </div>
          {editable && (
            <>
              <label style={{ marginTop: 8 }}><input type="checkbox" name="attest" /> I confirm these real facts are approved by the company.</label>
              <div className="row" style={{ marginTop: 10 }}>
                <button type="submit" className="secondary">Save draft</button>
                <button type="submit" name="publish" value="1">Save and publish</button>
              </div>
            </>
          )}
        </Card>
      </form>
    </>
  );
}
