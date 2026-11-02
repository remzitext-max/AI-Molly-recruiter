"use client";
// The Board's status cards: each shows how many drivers have that status and how many are
// stuck. A click opens the list of those drivers; a click on a driver opens their profile
// (LeadPopup listens for data-profile clicks anywhere on the page).
import { useEffect, useState } from "react";
import type { BoardColumn, BoardDriver } from "@/lib/board";
import { initialsOf } from "./ui";
import { CallNow } from "./call-now";

const age = (ms: number) => {
  const h = ms / 3600_000;
  return h < 1 ? `${Math.max(1, Math.round(ms / 60_000))}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
};

export function BoardStrip({ columns, showRecruiter }: { columns: BoardColumn[]; showRecruiter: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const col = columns.find((c) => c.status === open) ?? null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // A profile opened on top closes first.
      if (e.key === "Escape" && !document.querySelector(".dp-backdrop")) setOpen(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <div className="board-strip">
        {columns.map((c) => (
          <button key={c.status} type="button" className={`board-card${c.late ? " has-late" : ""}`} onClick={() => setOpen(c.status)} disabled={!c.drivers.length}>
            <span className="board-k">{c.status}</span>
            <span className="board-n">{c.drivers.length}</span>
            <span className={c.late ? "board-late" : "board-ok"}>
              {c.late ? c.lateText : c.status === "Hired" ? "last 30 days" : c.avgMs != null ? `avg ${age(c.avgMs)}` : "none"}
            </span>
          </button>
        ))}
      </div>

      {col && (
        <div className="modal-backdrop board-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setOpen(null); }}>
          <div className="board-modal" role="dialog" aria-label={col.status}>
            <div className="board-modal-head">
              <div>
                <h2>{col.status} <span className="muted">{col.drivers.length}</span></h2>
                {col.late > 0 && <div className="small board-late">{col.lateText}</div>}
              </div>
              <button type="button" className="secondary dp-close" aria-label="Close" onClick={() => setOpen(null)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="board-list">
              {col.drivers.map((d) => <Row key={d.key} d={d} showRecruiter={showRecruiter} />)}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Row({ d, showRecruiter }: { d: BoardDriver; showRecruiter: boolean }) {
  return (
    <div className={`board-row${d.leadId ? " clickable" : ""}`} {...(d.leadId ? { "data-profile": d.leadId } : {})} title={d.leadId ? "Open profile" : "Not one of Crystal's leads: no profile on the site"}>
      <i className={`board-dot ${d.tone}`} />
      <div className="board-who">
        <strong>{d.name}</strong>
        <div className="small muted">{[d.detail || d.phone, showRecruiter ? d.recruiter ?? "Pool" : null].filter(Boolean).join(" · ")}</div>
      </div>
      {showRecruiter && d.recruiter && <span className="avatar board-av" title={d.recruiter}>{initialsOf(d.recruiter)}</span>}
      <span className={`board-age ${d.tone}`} title={`Since ${new Date(d.since).toLocaleString()}`}>{d.status === "Hired" ? new Date(d.since).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : age(d.ageMs)}</span>
      <CallNow phone={d.phone} label="" className="btn secondary board-call" />
    </div>
  );
}
