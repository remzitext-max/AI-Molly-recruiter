import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { NavLink } from "@/components/nav-link";
import { Icon } from "@/components/icons";
import { initialsOf } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const [settings, org] = await Promise.all([getSettings(), db.organization.findUnique({ where: { id: user.orgId }, select: { name: true } })]);
  const admin = user.role === "ADMIN";
  const live = config.mode !== "demo";
  const contactOn = settings.liveContactEnabled && !!settings.contactPolicyConfirmedAt;
  return (
    <div className="shell">
      <nav className="nav">
        <div className="brand">
          <div className="logo">C</div>
          <div><div className="brand-name">Crystal AI</div><div className="brand-org">{org?.name ?? "Recruiting"}</div></div>
        </div>
        <div className="nav-group">Overview</div>
        <NavLink href="/dashboard" icon="dashboard" label="Dashboard" />
        <NavLink href="/leads" icon="leads" label="Leads" />
        <NavLink href="/tasks" icon="tasks" label="Tasks" />
        {admin && (
          <>
            <div className="nav-group">Recruiting</div>
            <NavLink href="/import" icon="import" label="Import leads" />
            <NavLink href="/knowledge" icon="offers" label="Offers & knowledge" />
            <NavLink href="/voice" icon="voice" label="Voice agent" />
          </>
        )}
        <div className="nav-group">Workspace</div>
        <NavLink href="/integrations" icon="integrations" label="Integrations" />
        {admin && <NavLink href="/users" icon="users" label="Users" />}
        {admin && <NavLink href="/jobs" icon="jobs" label="Background jobs" />}
        {admin && <NavLink href="/settings" icon="settings" label="Settings" />}
        <div className="who">
          <div className="avatar">{initialsOf(user.name)}</div>
          <div className="who-text"><div className="who-name">{user.name}</div><div className="who-role">{user.role.toLowerCase()}</div></div>
          <form action="/api/auth/logout" method="post"><button className="icon-btn" type="submit" title="Sign out" aria-label="Sign out"><Icon name="logout" size={16} /></button></form>
        </div>
      </nav>
      <main className="main">
        <div className="topbar">
          {live ? (
            <span className={`pill ${contactOn ? "pill-live" : "pill-off"}`}><span className="dot" />{contactOn ? "Live · real calls and texts on" : "Live · contact switched off"}</span>
          ) : (
            <span className="pill pill-demo"><span className="dot" />Demo mode · simulated calls, nothing reaches a real phone</span>
          )}
        </div>
        {settings.globalPause && <div className="banner paused"><Icon name="alert" size={16} /> Global pause is ON: no calls or texts will be sent.</div>}
        {children}
      </main>
    </div>
  );
}
