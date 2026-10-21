import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { recordEvent } from "@/lib/activity";
import { Badge, Card, fmt } from "@/components/ui";
import { flash } from "@/lib/flash";

async function newDraft(fd: FormData) {
  "use server";
  const u = await requireAdmin();
  const offer = await db.offer.findFirstOrThrow({ where: { id: String(fd.get("offerId")), orgId: u.orgId } });
  const base = offer.activeVersionId ? await db.offerVersion.findUnique({ where: { id: offer.activeVersionId } }) : null;
  const last = await db.offerVersion.findFirst({ where: { offerId: offer.id }, orderBy: { version: "desc" } });
  const v = await db.offerVersion.create({ data: { offerId: offer.id, version: (last?.version ?? 0) + 1, status: "DRAFT", synthetic: base?.synthetic ?? false, facts: base?.facts ?? [], createdById: u.id } });
  await recordEvent({ actorType: "USER", actorId: u.id, orgId: u.orgId, type: "OFFER_DRAFT", message: `Draft v${v.version} of "${offer.name}" created` });
  await flash("New draft created");
  redirect(`/knowledge/${v.id}`);
}

async function newOffer(fd: FormData) {
  "use server";
  const u = await requireAdmin();
  const name = String(fd.get("name") || "").trim();
  if (!name) return;
  const offer = await db.offer.create({ data: { orgId: u.orgId, name } });
  const v = await db.offerVersion.create({ data: { offerId: offer.id, version: 1, status: "DRAFT", synthetic: false, facts: [], createdById: u.id } });
  await flash("Offer created");
  redirect(`/knowledge/${v.id}`);
}

export default async function Knowledge() {
  const u = await requireAdmin();
  const offers = await db.offer.findMany({ where: { orgId: u.orgId }, include: { versions: { orderBy: { version: "desc" } }, campaigns: true } });
  return (
    <>
      <h1>Offers &amp; approved knowledge</h1>
      <p className="muted">The AI may only state facts published here, word for word. Anything missing or unconfirmed is captured as a question for Molly. Each call records which version was discussed.</p>
      {offers.map((o) => (
        <Card key={o.id} title={o.name} right={<form action={newDraft}><input type="hidden" name="offerId" value={o.id} /><button className="secondary">New draft version</button></form>}>
          <p className="small muted">Used by: {o.campaigns.map((c) => c.name).join(", ") || "no campaign"}</p>
          <table><thead><tr><th>Version</th><th>Status</th><th>Data</th><th>Facts</th><th>Published</th></tr></thead><tbody>
            {o.versions.map((v) => (
              <tr key={v.id}>
                <td><Link href={`/knowledge/${v.id}`}>v{v.version}</Link> {o.activeVersionId === v.id && <Badge v="ACTIVE" tone="ok" />}</td>
                <td><Badge v={v.status} tone={v.status === "PUBLISHED" ? "ok" : v.status === "DRAFT" ? "info" : ""} /></td>
                <td>{v.synthetic ? <Badge v="SYNTHETIC" tone="demo" /> : <Badge v="REAL" tone="ok" />}</td>
                <td>{Array.isArray(v.facts) ? v.facts.length : 0}</td>
                <td className="small">{fmt(v.publishedAt)}</td>
              </tr>
            ))}
          </tbody></table>
        </Card>
      ))}
      <Card title="Add offer">
        <form action={newOffer} className="inline"><input name="name" placeholder="Offer name" /><button>Create</button></form>
      </Card>
    </>
  );
}
