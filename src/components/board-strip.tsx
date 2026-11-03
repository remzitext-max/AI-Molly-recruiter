"use client";
// The Board's status cards: each shows how many drivers have that status and how many are
// stuck. A click opens the list of those drivers; a click on a driver opens their profile
// (LeadPopup listens for data-profile clicks anywhere on the page).
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { BoardColumn, BoardDriver } from "@/lib/board";
import { initialsOf } from "./ui";
import { CallNow } from "./call-now";
import { Icon } from "./icons";

const age = (ms: number) => {
  const h = ms / 3600_000;
  return h < 1 ? `${Math.max(1, Math.round(ms / 60_000))}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
};

/** `stuck`: the cards count only stuck drivers ("Needs a push" on the dashboard). */
export function BoardStrip({ columns, showRecruiter, stuck = false }: { columns: BoardColumn[]; showRecruiter: boolean; stuck?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const col = columns.find((c) => c.status === open) ?? null;

  return (
    <>
      <div className="board-strip">
        {columns.map((c) => (
          <button key={c.status} type="button" className={`board-card${c.late ? " has-late" : ""}${stuck ? " stuck" : ""}`} onClick={() => setOpen(c.status)} disabled={!c.drivers.length}>
            <span className="board-k">{c.status}</span>
            <span className={`board-n${stuck && c.drivers.length ? " bad-text" : ""}`}>{c.drivers.length}</span>
            <span className={c.late && !stuck ? "board-late" : "board-ok"}>
              {stuck ? c.rule : c.late ? c.lateText : c.status === "Hired" ? "last 30 days" : c.avgMs != null ? `avg ${age(c.avgMs)}` : "none"}
            </span>
          </button>
        ))}
      </div>

      {col && <DriverModal title={col.status} drivers={col.drivers} note={stuck ? col.rule : col.late > 0 ? col.lateText : ""} showRecruiter={showRecruiter} onClose={() => setOpen(null)} />}
    </>
  );
}

/** The list of drivers behind a status card or a dashboard number. */
function DriverModal({ title, drivers, note, showRecruiter, onClose }: { title: string; drivers: BoardDriver[]; note?: string; showRecruiter: boolean; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A profile opened on top closes first.
      if (e.key === "Escape" && !document.querySelector(".dp-backdrop")) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop board-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="board-modal" role="dialog" aria-label={title}>
        <div className="board-modal-head">
          <div>
            <h2>{title} <span className="muted">{drivers.length}</span></h2>
            {note && <div className="small board-late">{note}</div>}
          </div>
          <button type="button" className="secondary dp-close" aria-label="Close" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="board-list">
          {drivers.map((d) => <Row key={d.key} d={d} showRecruiter={showRecruiter} />)}
          {!drivers.length && <p className="muted small">No drivers.</p>}
        </div>
      </div>
    </div>
  );
}

/** A dashboard number (same look as Stat) that opens the list of its drivers on click. */
export function DriverStat({ label, sub, icon, tone, drivers, showRecruiter }: {
  label: string; sub?: ReactNode; icon?: string; tone?: "blue" | "violet" | "teal" | "green" | "amber" | "rose"; drivers: BoardDriver[]; showRecruiter: boolean;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button type="button" className={`stat stat-btn${tone ? ` tone-${tone}` : ""}`} onClick={() => setOpen(true)} disabled={!drivers.length} title={drivers.length ? "See the drivers" : undefined}>
        <div className="top"><div className="l">{label}</div>{icon && <span className="chip"><Icon name={icon} size={18} /></span>}</div>
        <div className="n">{drivers.length}</div>{sub && <div className="d">{sub}{drivers.length > 0 && <> · <span className="link-text">see who</span></>}</div>}
      </button>
      {open && <DriverModal title={label} drivers={drivers} showRecruiter={showRecruiter} onClose={close} />}
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
