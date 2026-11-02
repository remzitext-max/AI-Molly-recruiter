"use client";
// The top search box: matching drivers show under it while typing; a click (or Enter on a
// highlighted one) opens the driver's profile. Enter alone still opens the full Leads search.
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

interface Hit { id: string; name: string; phone: string; state: string | null; status: string; recruiter: string | null; team: string | null }

const fmtPhone = (p: string) => { const d = p.replace(/\D/g, "").slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p; };

export function TopSearch() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const box = useRef<HTMLFormElement>(null);
  const links = useRef<(HTMLAnchorElement | null)[]>([]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setHits([]); setLoading(false); return; }
    setLoading(true);
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: ctl.signal, cache: "no-store" })
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .then((j: { results: Hit[] }) => { setHits(j.results); setActive(-1); setLoading(false); })
        .catch(() => {});
    }, 180);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q]);

  useEffect(() => {
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(hits.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(-1, a - 1)); }
    else if (e.key === "Escape") setOpen(false);
    else if (e.key === "Enter" && active >= 0 && hits[active]) { e.preventDefault(); links.current[active]?.click(); }
  };

  const showList = open && q.trim().length >= 2;
  return (
    <form ref={box} action="/leads" method="get" className="search top-search" role="search">
      <Icon name="search" size={16} />
      <input
        name="q" value={q} autoComplete="off" placeholder="Search drivers by name or phone…" aria-label="Search leads"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onKey}
        role="combobox" aria-expanded={showList} aria-controls="top-search-list"
      />
      {showList && (
        <div className="ts-pop" id="top-search-list" role="listbox">
          {hits.map((h, i) => (
            <a
              key={h.id} ref={(el) => { links.current[i] = el; }} href={`/leads/${h.id}`} data-profile={h.id}
              className={`ts-item${i === active ? " on" : ""}`} role="option" aria-selected={i === active}
              onMouseEnter={() => setActive(i)} onClick={() => setOpen(false)}
            >
              <Icon name="search" size={14} />
              <div className="ts-main">
                <div className="ts-name">{h.name}</div>
                <div className="ts-sub">{[fmtPhone(h.phone), h.state, h.recruiter, h.team].filter(Boolean).join(" · ")}</div>
              </div>
              <span className="ts-status">{h.status}</span>
            </a>
          ))}
          {!hits.length && <div className="ts-empty">{loading ? "Searching…" : "No drivers found"}</div>}
          {hits.length > 0 && <button type="submit" className="ts-all">See all results for “{q.trim()}” ↵</button>}
        </div>
      )}
    </form>
  );
}
