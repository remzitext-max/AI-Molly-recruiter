import { lookupUploadToken } from "@/lib/documents";
import { UploadForm } from "./upload-form";
import { ConsentForm } from "./consent-form";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { recordConsentText } from "@/lib/documents";

export const dynamic = "force-dynamic";
export const metadata = { title: "Secure CDL and medical card upload", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function UploadPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await lookupUploadToken(token);
  const s = t ? await getSettings() : null;
  const signed = t && s?.recordConsentEnabled ? await db.recordCheckConsent.findFirst({ where: { leadId: t.leadId }, orderBy: { createdAt: "desc" } }) : null;
  return (
    <div style={{ maxWidth: 460, margin: "6vh auto", padding: 16 }}>
      <div className="card">
        <h1>Upload your CDL and medical card</h1>
        {!t || t.lead.optedOutAt ? (
          <p>This link has expired or was already used. Please contact your recruiter for a new one.</p>
        ) : (
          <>
            {t.lead.isDemo && <div className="banner demo">DEMO: synthetic candidate</div>}
            <p className="small muted">{t.lead.org.name} recruiting team</p>
            <p>Hi{t.lead.firstName ? ` ${t.lead.firstName}` : ""}, please upload a clear photo of your commercial driver’s license (front, and back if asked) and your DOT medical card. Your files are stored privately and only your recruiting team can see them.</p>
            <p className="small muted">JPG, PNG, HEIC or PDF. This link works for about {Math.max(1, Math.round((t.expiresAt.getTime() - Date.now()) / 60000))} more minutes. Do not send your Social Security number or any other documents here.</p>
            <UploadForm token={token} remaining={t.maxFiles - t.filesUsed} />
          </>
        )}
      </div>
      {t && !t.lead.optedOutAt && s?.recordConsentEnabled && (
        <ConsentForm token={token} text={recordConsentText(s.recordConsentText, t.lead.org.name)} signedAt={signed ? signed.createdAt.toLocaleDateString("en-US", { dateStyle: "medium" }) : null} />
      )}
    </div>
  );
}
