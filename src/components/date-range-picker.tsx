"use client";
// Dashboard period picker in the style of Meta Ads Manager: presets on the left,
// two months of calendar on the right. Click a day for the start and another for
// the end (or the same day twice for one day), then Update.
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Icon } from "./icons";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = MONTHS.map((m) => m.slice(0, 3));
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const showDay = (s: string) => { const d = parse(s); return `${SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; };

type Props = { from: string; to: string; today: string; label: string };

export function DateRangePicker({ from, to, today, label }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [a, setA] = useState(from);
  const [b, setB] = useState<string | null>(to);
  const [month, setMonth] = useState(() => { const d = parse(to); return new Date(d.getFullYear(), d.getMonth() - 1, 1); });
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const t = parse(today);
  const presets: [string, string, string][] = [
    ["Today", today, today],
    ["Yesterday", iso(addDays(t, -1)), iso(addDays(t, -1))],
    ["Last 7 days", iso(addDays(t, -6)), today],
    ["Last 14 days", iso(addDays(t, -13)), today],
    ["Last 30 days", iso(addDays(t, -29)), today],
    ["This month", iso(new Date(t.getFullYear(), t.getMonth(), 1)), today],
    ["Last month", iso(new Date(t.getFullYear(), t.getMonth() - 1, 1)), iso(new Date(t.getFullYear(), t.getMonth(), 0))],
  ];

  const go = (f: string, e: string) => {
    const q = new URLSearchParams(params.toString());
    q.delete("range");
    q.set("from", f <= e ? f : e);
    q.set("to", f <= e ? e : f);
    setOpen(false);
    router.push(`/dashboard?${q}`);
  };
  const pick = (d: string) => {
    if (d > today) return;
    if (b === null) { if (d < a) { setB(a); setA(d); } else setB(d); }
    else { setA(d); setB(null); }
  };
  const end = b ?? a;

  const monthGrid = (m: Date) => {
    const first = new Date(m.getFullYear(), m.getMonth(), 1);
    const lead = first.getDay();
    const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => iso(new Date(m.getFullYear(), m.getMonth(), i + 1)))];
    return (
      <div className="drp-month" key={iso(m)}>
        <div className="drp-mtitle">{MONTHS[m.getMonth()]} {m.getFullYear()}</div>
        <div className="drp-grid">
          {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((w) => <span key={w} className="drp-wd">{w}</span>)}
          {cells.map((d, i) => d === null ? <span key={`e${i}`} /> : (
            <button type="button" key={d} disabled={d > today}
              className={`drp-day${d >= a && d <= end ? " in" : ""}${d === a || d === end ? " edge" : ""}${d === today ? " today" : ""}`}
              onClick={() => pick(d)}>{parse(d).getDate()}</button>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="drp" ref={box}>
      <button type="button" className="secondary drp-btn" onClick={() => { setA(from); setB(to); setOpen((o) => !o); }} aria-expanded={open}>
        <Icon name="calendar" size={16} />{label}<span className="muted small">{from === to ? showDay(from) : `${showDay(from)} – ${showDay(to)}`}</span>
      </button>
      {open && (
        <div className="drp-pop" role="dialog" aria-label="Choose dates">
          <div className="drp-presets">
            {presets.map(([name, f, e]) => (
              <button type="button" key={name} className={f === a && e === end ? "on" : ""} onClick={() => { setA(f); setB(e); }}>{name}</button>
            ))}
          </div>
          <div className="drp-cal">
            <div className="drp-nav">
              <button type="button" className="secondary" aria-label="Earlier" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
              <button type="button" className="secondary" aria-label="Later" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
            </div>
            <div className="drp-months">{monthGrid(month)}{monthGrid(new Date(month.getFullYear(), month.getMonth() + 1, 1))}</div>
            <div className="drp-foot">
              <span className="small">{a === end ? showDay(a) : `${showDay(a)} – ${showDay(end)}`}{b === null && <span className="muted"> · pick the end day, or Update for one day</span>}</span>
              <span className="row">
                <button type="button" className="secondary" onClick={() => setOpen(false)}>Cancel</button>
                <button type="button" onClick={() => go(a, end)}>Update</button>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
