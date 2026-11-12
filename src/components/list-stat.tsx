"use client";
// A dashboard number that opens a window on click: a few rates at the top ("see who" picks
// that list), then the drivers in groups. A click on a driver opens their profile
// (LeadPopup listens for data-profile clicks anywhere on the page).
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Icon } from "./icons";
import { CallNow } from "./call-now";

export interface ListItem { key: string; leadId: string | null; name: string; phone: string; sub: string; badge?: string; tone?: "ok" | "warn" | "late" }
export interface ListGroup { key: string; label: string; items: ListItem[] }
export interface ListRate { label: string; value: string; sub: string; group: string }

export function ListStat({ label, icon, tone, n, sub, rates = [], groups }: {
  label: string; icon?: string; tone?: "blue" | "violet" | "teal" | "green" | "amber" | "rose"; n: ReactNode; sub?: ReactNode;
  rates?: ListRate[]; groups: ListGroup[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const empty = !groups.some((g) => g.items.length);
  return (
    <>
      <button type="button" className={`stat stat-btn${tone ? ` tone-${tone}` : ""}`} onClick={() => setOpen(groups[0]?.key ?? null)} disabled={empty} title={empty ? undefined : "See the details"}>
        <div className="top"><div className="l">{label}</div>{icon && <span className="chip"><Icon name={icon} size={18} /></span>}</div>
        <div className="n">{n}</div>
        <div className="d">{sub}{!empty && <>{sub ? " · " : ""}<span className="link-text">see who</span></>}</div>
      </button>
      {open && <ListModal title={label} n={n} rates={rates} groups={groups} group={open} setGroup={setOpen} onClose={close} />}
    </>
  );
}

function ListModal({ title, n, rates, groups, group, setGroup, onClose }: {
  title: string; n: ReactNode; rates: ListRate[]; groups: ListGroup[]; group: string; setGroup: (g: string) => void; onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A profile opened on top closes first.
      if (e.key === "Escape" && !document.querySelector(".dp-backdrop")) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const g = groups.find((x) => x.key === group) ?? groups[0];
  return (
    <div className="modal-backdrop board-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="board-modal ls-modal" role="dialog" aria-label={title}>
        <div className="board-modal-head">
          <h2>{title} <span className="muted">{n}</span></h2>
          <button type="button" className="secondary dp-close" aria-label="Close" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
        {rates.length > 0 && (
          <div className="ls-rates">
            {rates.map((r) => (
              <button key={r.label} type="button" className={`secondary ls-rate${r.group === g.key ? " on" : ""}`} onClick={() => setGroup(r.group)}>
                <span className="l">{r.label}</span>
                <span className="v">{r.value}</span>
                <span className="s">{r.sub} · <span className="link-text">see who</span></span>
              </button>
            ))}
          </div>
        )}
        <div className="tabs ls-tabs">
          {groups.map((x) => (
            <button key={x.key} type="button" className={`secondary tab${x.key === g.key ? " on" : ""}`} onClick={() => setGroup(x.key)}>{x.label}<span className="c">{x.items.length}</span></button>
          ))}
        </div>
        <div className="board-list">
          {g.items.map((it) => (
            <div key={it.key} className={`board-row${it.leadId ? " clickable" : ""}`} {...(it.leadId ? { "data-profile": it.leadId } : {})} title={it.leadId ? "Open profile" : "Not one of Crystal's leads: no profile on the site"}>
              <i className={`board-dot ${it.tone ?? "ok"}`} />
              <div className="board-who">
                <strong>{it.name}</strong>
                <div className="small muted">{it.sub}</div>
              </div>
              {it.badge && <span className="badge">{it.badge}</span>}
              <CallNow phone={it.phone} label="" className="btn secondary board-call" />
            </div>
          ))}
          {!g.items.length && <p className="muted small">No drivers.</p>}
        </div>
      </div>
    </div>
  );
}
