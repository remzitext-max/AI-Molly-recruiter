"use client";
import { useState } from "react";
import { US_STATES } from "@/lib/timezone";

export function ApplyForm({ src, campaign, ad }: { src: string; campaign: string; ad: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(""); setState("busy");
    const data = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
    const res = await fetch("/api/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...data, src, campaign, ad }) });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) { setErr(j.error ?? "Something went wrong. Please try again."); setState("idle"); return; }
    setState("done");
  }

  if (state === "done") return <div className="banner" style={{ marginTop: 16 }}><b>Thank you!</b> Our recruiting team will call you shortly from a US number. Please pick up.</div>;

  const row = { display: "flex", flexDirection: "column" as const, gap: 4, marginTop: 12 };
  return (
    <form onSubmit={submit}>
      <label style={row}>Full name<input name="name" required autoComplete="name" /></label>
      <label style={row}>Phone<input name="phone" type="tel" required autoComplete="tel" inputMode="tel" placeholder="(555) 555-5555" /></label>
      <label style={row}>Email (optional)<input name="email" type="email" autoComplete="email" /></label>
      <label style={row}>State you live in<select name="state" required defaultValue=""><option value="" disabled>Choose</option>{[...US_STATES].sort().map((s) => <option key={s}>{s}</option>)}</select></label>
      <label style={row}>Solo or team?<select name="position" required defaultValue=""><option value="" disabled>Choose</option><option>Solo</option><option>Team</option></select></label>
      <label style={row}>CDL-A experience<select name="experience" required defaultValue=""><option value="" disabled>Choose</option><option>Less than 1 year</option><option>1-2 years</option><option>2-5 years</option><option>5+ years</option></select></label>
      <label style={row}>Any SAP / failed drug or alcohol test?<select name="sap" required defaultValue=""><option value="" disabled>Choose</option><option>No</option><option>Yes</option></select></label>
      <input name="website" tabIndex={-1} autoComplete="off" style={{ position: "absolute", left: -9999 }} aria-hidden="true" />
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 14 }} className="small">
        <input type="checkbox" name="consent" value="yes" required style={{ marginTop: 3 }} />
        <span>I agree that TBT Express may call and text me about driving jobs at this number, including with automated technology and an AI assistant. Consent is not a condition of employment. Msg &amp; data rates may apply. Reply STOP to opt out. <a href="/privacy" target="_blank">Privacy</a></span>
      </label>
      {err && <p style={{ color: "var(--danger, #c00)" }}>{err}</p>}
      <button type="submit" disabled={state === "busy"} style={{ width: "100%", marginTop: 16 }}>{state === "busy" ? "Sending..." : "Apply now"}</button>
    </form>
  );
}
