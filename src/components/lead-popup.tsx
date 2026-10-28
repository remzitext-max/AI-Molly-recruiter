"use client";
// Opens a driver's profile in a popup when a lead row (or its name) marked
// data-profile is clicked. Ctrl/Cmd-click on the name still opens the full page.
// From the popup a recruiter sets the status, transfers the lead, edits the
// profile and downloads it as PDF.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BASIC_FIELDS, PROFILE_FIELDS } from "@/lib/profile-fields";
import type { DriverProfile } from "@/lib/driver-profile";
import { DriverProfileView } from "./driver-profile-view";
import { Icon } from "./icons";

type Loaded = DriverProfile & { options: { statuses: string[]; recruiters: { id: string; name: string }[] } };

export function LeadPopup() {
  const router = useRouter();
  const [id, setId] = useState<string | null>(null);
  const [p, setP] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = useRef(false);

  const close = useCallback(() => {
    setId(null); setP(null); setError(""); setNote(""); setEditing(false);
    // The list behind shows the new status / recruiter after a change.
    if (dirty.current) { dirty.current = false; router.refresh(); }
  }, [router]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      const t = e.target as HTMLElement;
      const row = t.closest<HTMLElement>("[data-profile]");
      if (!row) return;
      // Controls inside the row keep working; the name link is the one link that opens the popup.
      const control = t.closest("a, button, input, select, textarea, label, summary, audio");
      if (control && !control.hasAttribute("data-profile")) return;
      e.preventDefault();
      e.stopPropagation();
      setId(row.dataset.profile!);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  const load = useCallback(async (leadId: string, init?: RequestInit) => {
    const r = await fetch(`/api/leads/${leadId}/profile`, { cache: "no-store", ...init });
    if (!r.ok) throw new Error(r.status === 404 ? "Lead not found" : "Could not load the profile");
    setP(await r.json());
  }, []);

  useEffect(() => {
    if (!id) return;
    load(id).catch((e: Error) => setError(e.message));
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [id, close, load]);

  const post = async (path: string, body: unknown, done: string) => {
    if (!id) return;
    setBusy(true); setNote("");
    try {
      const r = await fetch(`/api/leads/${id}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.text()) || "Not saved");
      if (path === "profile") setP(await r.json()); else await load(id);
      dirty.current = true;
      setNote(done);
    } catch (e) {
      setNote(`Not saved: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const save = (fd: FormData) => post("profile", { values: Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)])) }, "Profile saved").then(() => setEditing(false));

  if (!id) return null;
  return (
    <div className="modal-backdrop dp-backdrop" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dp-modal" role="dialog" aria-modal="true" aria-label="Driver profile">
        <div className="dp-bar">
          {p && !editing && <button type="button" className="secondary" onClick={() => setEditing(true)}>Edit profile</button>}
          <a className="btn secondary" href={`/api/leads/${id}/pdf`}><Icon name="download" size={16} />Download PDF</a>
          <a className="btn secondary" href={`/leads/${id}`}>Open full page</a>
          <button type="button" className="secondary dp-close" onClick={close} aria-label="Close">✕</button>
        </div>
        <div className="dp-body">
          {error ? <p className="alert error">{error}</p> : !p ? <p className="muted">Loading…</p> : (
            <>
              <div className="dp-actions">
                <label>Status
                  <select value={p.options.statuses.includes(p.status) ? p.status : ""} disabled={busy} onChange={(e) => post("status", { status: e.target.value }, `Status set to ${e.target.value}`)}>
                    <option value="" disabled>Not set</option>
                    {p.options.statuses.map((s) => <option key={s}>{s}</option>)}
                  </select>
                </label>
                <label>Transfer to
                  <select defaultValue="" disabled={busy} onChange={(e) => { const to = p.options.recruiters.find((r) => r.id === e.target.value); if (to) post("transfer", { userId: to.id }, `Lead transferred to ${to.name}`); e.target.value = ""; }}>
                    <option value="" disabled>{p.recruiter}</option>
                    {p.options.recruiters.filter((r) => r.name !== p.recruiter).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </label>
                {note && <span className={`small ${note.startsWith("Not saved") ? "bad-text" : "ok-text"}`}>{note}</span>}
              </div>
              {editing ? (
                <form className="dp-edit" action={save}>
                  <h3 className="dp-h">Driver</h3>
                  <div className="dp-grid">
                    {BASIC_FIELDS.map((f) => <label key={f.key}>{f.label}<input name={f.key} defaultValue={p.edit[f.key]} /></label>)}
                    {PROFILE_FIELDS.filter((f) => f.section !== "employers").map((f) => <label key={f.key}>{f.label}<input name={f.key} defaultValue={p.edit[f.key]} /></label>)}
                  </div>
                  {PROFILE_FIELDS.filter((f) => f.section === "employers").map((f) => (
                    <label key={f.key} className="dp-wide">{f.label}<textarea name={f.key} rows={4} defaultValue={p.edit[f.key]} placeholder={"Werner, 04/2024 - now, OTR\nSwift, 2022 - 03/2024, OTR"} /></label>
                  ))}
                  <p className="small muted">What the driver told Crystal is kept in the history; your values are shown in the profile and the PDF.</p>
                  <div className="row"><button disabled={busy}>Save profile</button><button type="button" className="secondary" onClick={() => setEditing(false)}>Cancel</button></div>
                </form>
              ) : <DriverProfileView p={p} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
