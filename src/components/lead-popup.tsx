"use client";
// Opens a driver's profile in a popup when a lead row (or its name) marked
// data-profile is clicked. Ctrl/Cmd-click on the name still opens the full page.
import { useCallback, useEffect, useState } from "react";
import type { DriverProfile } from "@/lib/driver-profile";
import { DriverProfileView } from "./driver-profile-view";
import { Icon } from "./icons";

export function LeadPopup() {
  const [id, setId] = useState<string | null>(null);
  const [p, setP] = useState<DriverProfile | null>(null);
  const [error, setError] = useState("");

  const close = useCallback(() => { setId(null); setP(null); setError(""); }, []);

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

  useEffect(() => {
    if (!id) return;
    let live = true;
    fetch(`/api/leads/${id}/profile`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 404 ? "Lead not found" : "Could not load the profile"))))
      .then((d) => { if (live) setP(d); })
      .catch((e: Error) => { if (live) setError(e.message); });
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { live = false; document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [id, close]);

  if (!id) return null;
  return (
    <div className="modal-backdrop dp-backdrop" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dp-modal" role="dialog" aria-modal="true" aria-label="Driver profile">
        <div className="dp-bar">
          <a className="btn secondary" href={`/api/leads/${id}/pdf`}><Icon name="download" size={16} />Download PDF</a>
          <a className="btn secondary" href={`/leads/${id}`}>Open full page</a>
          <button type="button" className="secondary dp-close" onClick={close} aria-label="Close">✕</button>
        </div>
        <div className="dp-body">
          {error ? <p className="alert error">{error}</p> : p ? <DriverProfileView p={p} /> : <p className="muted">Loading…</p>}
        </div>
      </div>
    </div>
  );
}
