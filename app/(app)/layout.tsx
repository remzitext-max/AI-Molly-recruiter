import type { ReactNode } from "react";
import { isOwner, requireUser } from "@/lib/auth";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { readFlash } from "@/lib/flash";
import { NavLink } from "@/components/nav-link";
import { Icon } from "@/components/icons";
import { Shell } from "@/components/shell";
import { Toaster } from "@/components/toaster";
import { initialsOf } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const [settings, org, flash] = await Promise.all([getSettings(), db.organization.findUnique({ where: { id: user.orgId }, select: { name: true } }), readFlash()]);
  const admin = user.role === "ADMIN";
  // A team's manager manages their logins; the company's setup pages are the owner's.
  const owner = await isOwner(user);
  const live = config.mode !== "demo";
  const contactOn = settings.liveContactEnabled && !!settings.contactPolicyConfirmedAt;
  const nav = (
    <>
      <div className="brand">
        <div className="logo">C</div>
        <div className="brand-text"><div className="brand-name">Crystal AI</div><div className="brand-org">{org?.name ?? "Recruiting"}</div></div>
      </div>
      <div className="nav-group">Overview</div>
      <NavLink href="/dashboard" icon="dashboard" label="Dashboard" />
      <NavLink href="/leads" icon="leads" label="Leads" />
      <NavLink href="/process" icon="check" label="On process" />
      <NavLink href="/tasks" icon="tasks" label="Tasks" />
      {owner && (
        <>
          <div className="nav-group">Recruiting</div>
          <NavLink href="/import" icon="import" label="Import leads" />
          <NavLink href="/knowledge" icon="offers" label="Offers & knowledge" />
          <NavLink href="/voice" icon="voice" label="Voice agent" />
          <NavLink href="/ads" icon="ads" label="Facebook ads" />
        </>
      )}
      {admin && <div className="nav-group">Workspace</div>}
      {owner && <NavLink href="/integrations" icon="integrations" label="Integrations" />}
      {admin && <NavLink href="/users" icon="users" label="Users" />}
      {owner && <NavLink href="/teams" icon="leads" label="Teams" />}
      {owner && <NavLink href="/jobs" icon="jobs" label="Background jobs" />}
      {owner && <NavLink href="/settings" icon="settings" label="Settings" />}
      <div className="who">
        <div className="avatar">{initialsOf(user.name)}</div>
        <div className="who-text"><div className="who-name">{user.name}</div><div className="who-role">{user.role.toLowerCase()}</div></div>
        <form action="/api/auth/logout" method="post"><button className="icon-btn" type="submit" title="Sign out" aria-label="Sign out"><Icon name="logout" size={16} /></button></form>
      </div>
    </>
  );
  const pill = live ? (
    <span className={`pill ${contactOn ? "pill-live" : "pill-off"}`}><span className="dot" />{contactOn ? "Live · real calls and texts on" : "Live · contact switched off"}</span>
  ) : (
    <span className="pill pill-demo"><span className="dot" />Demo mode · simulated calls</span>
  );
  return (
    <Shell nav={nav} right={pill}>
      {settings.globalPause && <div className="banner paused"><Icon name="alert" size={16} /> Global pause is ON: no calls or texts will be sent.</div>}
      {children}
      <Toaster flash={flash} />
    </Shell>
  );
}
