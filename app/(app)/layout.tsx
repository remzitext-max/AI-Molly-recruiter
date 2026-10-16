import type { ReactNode } from "react";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { config } from "@/lib/config";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const settings = await getSettings();
  const admin = user.role === "ADMIN";
  return (
    <div className="shell">
      <nav className="nav">
        <div className="brand">Molly Recruiting</div>
        <Link href="/dashboard">Dashboard</Link>
        <Link href="/leads">Candidates</Link>
        <Link href="/tasks">Tasks</Link>
        {admin && <Link href="/import">Import leads</Link>}
        {admin && <Link href="/knowledge">Offers &amp; knowledge</Link>}
        {admin && <Link href="/voice">Voice</Link>}
        <Link href="/integrations">Integrations</Link>
        {admin && <Link href="/settings">Controls &amp; policy</Link>}
        {admin && <Link href="/users">Users</Link>}
        {admin && <Link href="/jobs">Background jobs</Link>}
        <div className="who">
          {user.name} · {user.role.toLowerCase()}
          <form action="/api/auth/logout" method="post" style={{ marginTop: 6 }}><button className="secondary" type="submit">Sign out</button></form>
        </div>
      </nav>
      <main className="main">
        {config.mode === "demo" ? (
          <div className="banner demo">DEMO MODE · synthetic leads · simulated calls and texts · nothing reaches a real phone</div>
        ) : (
          <div className="banner live">
            LIVE MODE · real contact {settings.liveContactEnabled && settings.contactPolicyConfirmedAt ? "ENABLED" : "DISABLED (policy/switch not set)"}
          </div>
        )}
        {settings.globalPause && <div className="banner paused">Global pause is ON: no calls or texts will be sent.</div>}
        {children}
      </main>
    </div>
  );
}
