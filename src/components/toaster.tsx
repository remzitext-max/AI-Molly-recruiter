"use client";
// Shows the server action's flash message as a toast at the bottom, and marks the
// clicked submit button as busy ("Saving…") until the page answers.
import { useEffect, useRef, useState } from "react";
import type { Flash } from "@/lib/flash";

const ICON: Record<Flash["tone"], string> = { ok: "✓", error: "!", info: "i" };

export function Toaster({ flash }: { flash: Flash | null }) {
  const [items, setItems] = useState<Flash[]>([]);
  const shown = useRef(new Set<string>());

  useEffect(() => {
    document.querySelectorAll(".is-busy").forEach((b) => b.classList.remove("is-busy"));
    if (!flash || shown.current.has(flash.id)) return;
    shown.current.add(flash.id);
    document.cookie = "flash=; Max-Age=0; path=/";
    setItems((xs) => [...xs, flash]);
    const t = setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== flash.id)), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  useEffect(() => {
    const onSubmit = (e: SubmitEvent) => {
      const form = e.target as HTMLFormElement;
      if (form.method.toLowerCase() === "get") return;
      const btn = (e.submitter as HTMLElement | null) ?? form.querySelector("button[type=submit], button:not([type])");
      if (!btn) return;
      // After the browser has read the form, so the button's own value is still sent.
      setTimeout(() => btn.classList.add("is-busy"), 0);
      setTimeout(() => btn.classList.remove("is-busy"), 15000);
    };
    document.addEventListener("submit", onSubmit);
    return () => document.removeEventListener("submit", onSubmit);
  }, []);

  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <span className="toast-icon">{ICON[t.tone]}</span>
          <span>{t.message}</span>
          <button type="button" className="toast-x" aria-label="Close" onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}>×</button>
        </div>
      ))}
    </div>
  );
}
