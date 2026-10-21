import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { ingestLead } from "@/lib/leads";
import { config } from "@/lib/config";
import { randomToken } from "@/lib/crypto";
import { Card } from "@/components/ui";
import { flash } from "@/lib/flash";

async function create(fd: FormData) {
  "use server";
  const u = await requireAdmin();
  const g = (k: string) => String(fd.get(k) ?? "").trim();
  const permission: { scope: "AI_CALL" | "SMS"; source: string; grantedAt: string; evidence?: string }[] = [];
  if (g("callPermSource") && g("callPermDate")) permission.push({ scope: "AI_CALL", source: g("callPermSource"), grantedAt: new Date(g("callPermDate")).toISOString(), evidence: g("permEvidence") || undefined });
  if (g("smsPermSource") && g("smsPermDate")) permission.push({ scope: "SMS", source: g("smsPermSource"), grantedAt: new Date(g("smsPermDate")).toISOString(), evidence: g("permEvidence") || undefined });
  const campaign = await db.campaign.findFirstOrThrow({ where: { id: g("campaignId"), orgId: u.orgId } });
  const r = await ingestLead(
    { sourceSystem: "MANUAL", sourceRecordId: g("sourceRecordId") || `manual-${randomToken(9)}`, firstName: g("firstName"), lastName: g("lastName"), phone: g("phone"), email: g("email"), state: g("state"), zip: g("zip"), permission },
    { orgId: u.orgId, campaignId: campaign.id, isDemo: config.mode === "demo" || campaign.isDemo, actorId: u.id },
  );
  if (r.result === "invalid") redirect(`/leads/new?error=${encodeURIComponent(r.error)}`);
  await flash("Lead added");
  redirect(`/leads/${r.leadId}`);
}

export default async function NewLead({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const u = await requireAdmin();
  const sp = await searchParams;
  const campaigns = await db.campaign.findMany({ where: { orgId: u.orgId } });
  return (
    <>
      <h1>Add lead manually</h1>
      {sp.error && <div className="alert error">{sp.error}</div>}
      <Card>
        <form action={create}>
          <div className="grid two">
            <div><label>First name</label><input name="firstName" /></div>
            <div><label>Last name</label><input name="lastName" /></div>
            <div><label>Phone *</label><input name="phone" required /></div>
            <div><label>Email</label><input name="email" type="email" /></div>
            <div><label>State (2 letters)</label><input name="state" maxLength={2} /></div>
            <div><label>ZIP</label><input name="zip" maxLength={10} /></div>
            <div><label>Source record ID (optional)</label><input name="sourceRecordId" /></div>
            <div><label>Campaign</label><select name="campaignId">{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}{c.isDemo ? " (demo)" : ""}</option>)}</select></div>
          </div>
          <h3>Contact permission (leave blank if none was given)</h3>
          <p className="small muted">Possession of a phone number is not permission. Record where and when the driver agreed to automated AI calls / texts.</p>
          <div className="grid two">
            <div><label>AI-call permission source</label><input name="callPermSource" placeholder="e.g. Job application form checkbox" /></div>
            <div><label>AI-call permission date/time</label><input name="callPermDate" type="datetime-local" /></div>
            <div><label>SMS permission source</label><input name="smsPermSource" /></div>
            <div><label>SMS permission date/time</label><input name="smsPermDate" type="datetime-local" /></div>
          </div>
          <label>Evidence / notes</label><textarea name="permEvidence" rows={2} />
          <div style={{ marginTop: 12 }}><button type="submit">Create lead</button></div>
        </form>
      </Card>
    </>
  );
}
