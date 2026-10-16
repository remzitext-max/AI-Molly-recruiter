import type { ReactNode } from "react";

const TONE: Record<string, string> = {
  INTERESTED: "ok", DOCS_RECEIVED: "ok", HANDOFF_READY: "ok", HANDED_OFF: "ok", RECEIVED: "ok", COMPLETED: "ok", CONFIRMED: "ok", configured: "ok", DONE: "ok",
  QUEUED: "info", CONTACTING: "info", DOCS_REQUESTED: "info", REQUESTED: "info", CALLBACK_SCHEDULED: "info", DIALING: "info", IN_PROGRESS: "info", ATTEMPTING: "info", OPEN: "info",
  NEEDS_PERMISSION: "warn", NEEDS_TIMEZONE: "warn", NO_ANSWER: "warn", VOICEMAIL: "warn", BUSY: "warn", UNKNOWN: "warn", EXPIRED: "warn", missing_credentials: "warn", not_implemented: "warn", UNCLEAR: "warn",
  OPTED_OUT: "bad", FAILED: "bad", NOT_INTERESTED: "bad", CLOSED: "bad", blocked: "bad", DEAD: "bad", CANCELED: "bad",
  mock: "demo", DEMO: "demo",
};

export function Badge({ v, tone }: { v: string | null | undefined; tone?: string }) {
  if (!v) return <span className="muted">—</span>;
  return <span className={`badge ${tone ?? TONE[v] ?? ""}`}>{v.replace(/_/g, " ").toLowerCase()}</span>;
}

export function Stat({ n, label }: { n: number | string; label: string }) {
  return <div className="stat"><div className="n">{n}</div><div className="l">{label}</div></div>;
}

export function Card({ title, children, right }: { title?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="card">
      {(title || right) && <div className="spread" style={{ marginBottom: 8 }}>{title && <h2>{title}</h2>}{right}</div>}
      {children}
    </div>
  );
}

export const fmt = (d: Date | null | undefined) => (d ? new Date(d).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—");
export const name = (l: { firstName: string | null; lastName: string | null }) => [l.firstName, l.lastName].filter(Boolean).join(" ") || "(no name)";
