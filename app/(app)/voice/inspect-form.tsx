"use client";
import { useState } from "react";

export function InspectForm() {
  const [report, setReport] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form className="inline" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      const res = await fetch("/api/voice/inspect", { method: "POST", body: new FormData(e.currentTarget) });
      setReport(await res.json());
      setBusy(false);
    }}>
      <input type="file" name="recording" accept="audio/*,.wav" required />
      <button className="secondary" disabled={busy}>{busy ? "Checking…" : "Inspect"}</button>
      {report && <pre style={{ width: "100%" }}>{JSON.stringify(report, null, 2)}</pre>}
    </form>
  );
}
