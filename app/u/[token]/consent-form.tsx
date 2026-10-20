"use client";
import { useState } from "react";

export function ConsentForm({ token, text, signedAt }: { token: string; text: string; signedAt: string | null }) {
  const [done, setDone] = useState(signedAt);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2 style={{ marginTop: 0 }}>Driving record check</h2>
      <p className="small">{text}</p>
      {done ? (
        <div className="alert ok">Thank you, your authorization was saved{done === "now" ? "" : ` on ${done}`}.</div>
      ) : (
        <form onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true); setErr(null);
          const res = await fetch(`/api/upload/${token}/consent`, { method: "POST", body: new FormData(e.currentTarget) });
          const j = await res.json().catch(() => ({ error: "Could not save" }));
          setBusy(false);
          if (res.ok) setDone("now"); else setErr(j.error);
        }}>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}><input type="checkbox" name="agree" required /> <span>I agree</span></label>
          <label className="small">Your full name (electronic signature)</label>
          <input name="fullName" required minLength={3} maxLength={100} autoComplete="name" style={{ width: "100%" }} />
          <div style={{ marginTop: 10 }}><button disabled={busy}>{busy ? "Saving…" : "Sign"}</button></div>
          {err && <div className="alert error" style={{ marginTop: 10 }}>{err}</div>}
        </form>
      )}
    </div>
  );
}
