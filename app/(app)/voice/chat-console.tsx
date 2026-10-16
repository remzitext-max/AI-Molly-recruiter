"use client";
import { useRef, useState } from "react";

type Line = { who: "AI" | "You" | "note"; text: string };

export function ChatConsole() {
  const [lines, setLines] = useState<Line[]>([]);
  const [state, setState] = useState<unknown>(null);
  const [text, setText] = useState("");
  const [speak, setSpeak] = useState(false);
  const [ended, setEnded] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  function say(t: string) {
    if (!speak || typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel(); // drop stale speech when a new reply arrives
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(t));
  }

  async function send(input: { type: string; text?: string }) {
    if (speak && window.speechSynthesis?.speaking) window.speechSynthesis.cancel(); // barge-in
    const res = await fetch("/api/sim/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state, input }) });
    const j = await res.json();
    if (!res.ok) { setLines((l) => [...l, { who: "note", text: j.error ?? "error" }]); return; }
    setState(j.state);
    setEnded(j.end);
    setLines((l) => [...l, ...(input.text ? [{ who: "You" as const, text: input.text }] : input.type !== "start" ? [{ who: "You" as const, text: `[${input.type}]` }] : []), { who: "AI", text: j.say }, ...j.actions.map((a: { type: string }) => ({ who: "note" as const, text: `action: ${JSON.stringify(a)}` })), { who: "note", text: `decision time ${j.latencyMs} ms` }]);
    say(j.say);
    setTimeout(() => box.current?.scrollTo(0, 1e9), 10);
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <button onClick={() => { setLines([]); setState(null); setEnded(false); void send({ type: "start" }); }}>Start new call</button>
        <label style={{ margin: 0 }}><input type="checkbox" checked={speak} onChange={(e) => setSpeak(e.target.checked)} /> speak replies (browser voice)</label>
      </div>
      <div className="chat" ref={box}>
        {lines.map((l, i) => (
          <div key={i} className={`turn ${l.who === "AI" ? "agent" : "driver"}`} style={l.who === "note" ? { fontSize: 11, color: "var(--muted)" } : undefined}>
            {l.who !== "note" && <span className="who">{l.who}</span>}{l.text}
          </div>
        ))}
      </div>
      <form className="row" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); if (!text.trim() || ended || !state) return; const t = text; setText(""); void send({ type: "speech", text: t }); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={ended ? "Call ended" : "Type what the driver says…"} style={{ flex: 1 }} disabled={ended || !state} />
        <button type="submit" disabled={ended || !state}>Send</button>
        <button type="button" className="secondary" disabled={ended || !state} onClick={() => void send({ type: "silence" })}>Silence</button>
      </form>
    </div>
  );
}
