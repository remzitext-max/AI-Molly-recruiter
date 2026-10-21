"use client";
// App frame: sidebar that collapses to icons on desktop and slides in on phones,
// a top bar with the menu button and lead search, and whole-row links on tables.
import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Icon } from "./icons";

const KEY = "crystal-nav-collapsed";

export function Shell({ nav, right, children }: { nav: ReactNode; right: ReactNode; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(false);
  const path = usePathname();
  const router = useRouter();

  useEffect(() => { try { setCollapsed(localStorage.getItem(KEY) === "1"); } catch {} }, []);
  useEffect(() => { setOpen(false); }, [path]);

  // Table rows marked data-href open their page when clicked anywhere but a control.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("a, button, input, select, textarea, label, summary, audio")) return;
      const row = t.closest<HTMLElement>("[data-href]");
      if (row?.dataset.href) router.push(row.dataset.href);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [router]);

  const toggle = () => {
    if (window.matchMedia("(max-width: 860px)").matches) { setOpen((o) => !o); return; }
    setCollapsed((c) => { try { localStorage.setItem(KEY, c ? "0" : "1"); } catch {} return !c; });
  };

  return (
    <div className={`shell${collapsed ? " collapsed" : ""}${open ? " nav-open" : ""}`}>
      <nav className="nav">{nav}</nav>
      <div className="nav-backdrop" onClick={() => setOpen(false)} />
      <main className="main">
        <div className="topbar">
          <button type="button" className="menu-btn" onClick={toggle} aria-label={collapsed ? "Open menu" : "Collapse menu"} title={collapsed ? "Open menu" : "Collapse menu"}>
            <Icon name="menu" size={20} />
          </button>
          <form action="/leads" method="get" className="search top-search">
            <Icon name="search" size={16} />
            <input name="q" placeholder="Search drivers by name or phone…" aria-label="Search leads" />
          </form>
          <div className="topbar-right">{right}</div>
        </div>
        {children}
      </main>
    </div>
  );
}
