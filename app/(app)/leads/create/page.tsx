import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { Card, PageHead } from "@/components/ui";
import { flash } from "@/lib/flash";
import { createOwnDriver, saveUploadedRecording } from "@/lib/recruiter-upload";

// "Create form": a recruiter's own driver (someone they called themselves, not a lead).
async function create(fd: FormData) {
  "use server";
  const u = await requireUser();
  const g = (k: string) => String(fd.get(k) ?? "").trim();
  const r = await createOwnDriver(u, { phone: g("phone"), firstName: g("firstName"), lastName: g("lastName"), state: g("state").toUpperCase(), drivingType: g("drivingType") });
  if ("error" in r) redirect(`/leads/create?error=${encodeURIComponent(r.error!)}`);
  const f = fd.get("recording");
  let note = r.existed ? "This number is already on the site, so the form is the existing driver's" : "Driver form created";
  if (f instanceof File && f.size) {
    const up = await saveUploadedRecording(u, r.leadId!, { name: f.name, data: Buffer.from(await f.arrayBuffer()) });
    note += "error" in up ? `, but the recording was not saved: ${up.error}` : ". Crystal is filling it from the recording, refresh in a minute or two";
  }
  await flash(note, r.existed ? "info" : "ok");
  redirect(`/leads/${r.leadId}`);
}

export default async function CreateForm({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireUser();
  const sp = await searchParams;
  return (
    <>
      <PageHead title="Create form" sub="For your own driver: someone you called yourself, not a lead from Facebook. Upload your call recording and Crystal fills the driver's profile from it. Crystal never calls these drivers." />
      {sp.error && <div className="alert error">{sp.error}</div>}
      <Card>
        <form action={create}>
          <div className="grid two">
            <div><label>Phone *</label><input name="phone" type="tel" required autoComplete="off" placeholder="(555) 123-4567" /></div>
            <div><label>Driver type</label><select name="drivingType" defaultValue=""><option value="">Not sure yet</option><option value="solo">Solo</option><option value="team">Team</option></select></div>
            <div><label>First name</label><input name="firstName" autoComplete="off" /></div>
            <div><label>Last name</label><input name="lastName" autoComplete="off" /></div>
            <div><label>State (2 letters)</label><input name="state" maxLength={2} autoComplete="off" /></div>
            <div><label>Call recording (mp3, wav, m4a or ogg, up to 40 MB)</label><input type="file" name="recording" accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/ogg,.mp3,.wav,.m4a,.ogg" /></div>
          </div>
          <p className="small muted">The driver is assigned to you. You can upload more recordings and edit every field on the driver&apos;s page later.</p>
          <div style={{ marginTop: 12 }}><button type="submit">Create form</button></div>
        </form>
      </Card>
    </>
  );
}
