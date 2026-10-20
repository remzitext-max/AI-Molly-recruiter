"use client";
import { useState } from "react";

export function UploadForm({ token, remaining }: { token: string; remaining: number }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [count, setCount] = useState(0);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  if (done) return <div className="alert ok">Thank you! Your recruiter has been notified and will review your CDL.</div>;
  return (
    <>
      <form onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const res = await fetch(`/api/upload/${token}`, { method: "POST", body: new FormData(e.currentTarget) });
        const j = await res.json().catch(() => ({ error: "Upload failed" }));
        setBusy(false);
        if (res.ok) { setCount((c) => c + 1); setMsg({ ok: true, text: "Uploaded. You can add the next photo (back side or medical card), or finish." }); (e.target as HTMLFormElement).reset(); }
        else setMsg({ ok: false, text: j.error });
      }}>
        <input type="file" name="file" accept="image/jpeg,image/png,image/heic,application/pdf" capture="environment" required />
        <div style={{ marginTop: 10 }}><button disabled={busy || count >= remaining}>{busy ? "Uploading…" : "Upload"}</button></div>
      </form>
      {msg && <div className={`alert ${msg.ok ? "ok" : "error"}`} style={{ marginTop: 10 }}>{msg.text}</div>}
      {count > 0 && (
        <form onSubmit={async (e) => { e.preventDefault(); const fd = new FormData(); fd.set("finish", "1"); await fetch(`/api/upload/${token}`, { method: "POST", body: fd }); setDone(true); }}>
          <button className="secondary" style={{ marginTop: 10 }}>I’m finished</button>
        </form>
      )}
    </>
  );
}
