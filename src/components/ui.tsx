import type { ReactNode } from "react";
import { Icon } from "./icons";

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

export function Stat({ n, label, sub, icon, tone }: { n: number | string; label: string; sub?: ReactNode; icon?: string; tone?: "blue" | "violet" | "teal" | "green" | "amber" | "rose" }) {
  return (
    <div className={`stat${tone ? ` tone-${tone}` : ""}`}>
      <div className="top"><div className="l">{label}</div>{icon && <span className="chip"><Icon name={icon} size={18} /></span>}</div>
      <div className="n">{n}</div>{sub && <div className="d">{sub}</div>}
    </div>
  );
}

export function Card({ title, children, right, flush }: { title?: string; children: ReactNode; right?: ReactNode; flush?: boolean }) {
  return (
    <div className={flush ? "card flush" : "card"}>
      {(title || right) && <div className="spread" style={{ marginBottom: 10 }}>{title && <h2>{title}</h2>}{right}</div>}
      {children}
    </div>
  );
}

export function PageHead({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return <div className="page-head"><div><h1>{title}</h1>{sub && <div className="sub">{sub}</div>}</div>{right}</div>;
}

/** Up to two initials from the letters of a name ("Molly (demo account)" -> "MD"). */
export const initialsOf = (s: string) =>
  (s.match(/\p{L}+/gu) ?? []).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
export const initials = (l: { firstName: string | null; lastName: string | null }) => initialsOf(`${l.firstName ?? ""} ${l.lastName ?? ""}`);

export const fmt = (d: Date | null | undefined) => (d ? new Date(d).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—");
export const name = (l: { firstName: string | null; lastName: string | null }) => [l.firstName, l.lastName].filter(Boolean).join(" ") || "(no name)";
