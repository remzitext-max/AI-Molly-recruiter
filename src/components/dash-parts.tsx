// Small pieces the dashboards share: the change against the previous period and the
// calls-per-day chart.
import type { ReactNode } from "react";

export function Delta({ now, prev, invert }: { now: number; prev: number; invert?: boolean }) {
  if (!prev && !now) return <span>no change</span>;
  if (!prev) return <span className={invert ? "delta-down" : "delta-up"}>new</span>;
  const d = Math.round(((now - prev) / prev) * 100);
  if (d === 0) return <span>same as before</span>;
  const good = invert ? d < 0 : d > 0;
  return <span><span className={good ? "delta-up" : "delta-down"}>{d > 0 ? "▲" : "▼"} {Math.abs(d)}%</span> vs previous</span>;
}

export function CallsChart({ days }: { days: { label: string; answered: number; other: number }[] }) {
  const W = 720, H = 220, L = 30, R = 18, B = 24, T = 10;
  const max = Math.max(4, ...days.map((d) => d.answered + d.other));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const slot = (W - L - R) / days.length;
  const bw = Math.max(4, Math.min(28, slot - 6));
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Calls per day, talked and not">
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line className="grid-line" x1={L} x2={W - R} y1={y(i * step)} y2={y(i * step)} />
            <text className="axis" x={L - 6} y={y(i * step) + 4} textAnchor="end">{i * step}</text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = L + i * slot + (slot - bw) / 2;
          const ya = y(d.answered), yo = y(d.answered + d.other);
          const showLabel = days.length <= 14 || i % 3 === 0 || i === days.length - 1;
          return (
            <g key={i}>
              <title>{`${d.label}: ${d.answered + d.other} calls, ${d.answered} talked to a driver`}</title>
              <rect x={L + i * slot} y={T} width={slot} height={H - T - B} fill="transparent" />
              {d.other > 0 && <rect x={x} y={yo} width={bw} height={Math.max(0, ya - yo - (d.answered ? 2 : 0))} rx={3} fill="var(--series-muted)" />}
              {d.answered > 0 && <rect x={x} y={ya} width={bw} height={y(0) - ya} rx={3} fill="var(--series-1)" />}
              {showLabel && <text className="axis" x={x + bw / 2} y={H - 6} textAnchor="middle">{d.label}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** A labelled bar row; a link when href is given. */
export function BarRow({ label, n, max, total, href, cols = "190px 1fr 80px" }: { label: ReactNode; n: number; max: number; total?: number; href?: string; cols?: string }) {
  const inner = (
    <>
      <span>{label}</span>
      <div className="bar-track"><div className="bar-fill" style={{ width: `${(n / Math.max(1, max)) * 100}%` }} /></div>
      <span className="num">{n}{total ? <> <span className="muted">{Math.round((n / total) * 100)}%</span></> : null}</span>
    </>
  );
  return href
    ? <a className="hbar" href={href} style={{ gridTemplateColumns: cols }}>{inner}</a>
    : <div className="hbar" style={{ gridTemplateColumns: cols }}>{inner}</div>;
}
