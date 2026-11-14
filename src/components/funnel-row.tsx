// The funnel row: one step per column with its number, a bar (its share of the new leads)
// and the percent of the step it comes from. On a narrow screen the steps wrap and the
// arrows go.
import { Fragment } from "react";
import type { FunnelStep } from "@/lib/funnel";

export function FunnelRow({ steps }: { steps: FunnelStep[] }) {
  return (
    <div className="card fr">
      {steps.map((s, i) => (
        <Fragment key={s.label}>
          {i > 0 && (s.split
            ? <div className="fr-split" aria-hidden><i /></div>
            : <div className="fr-arrow" aria-hidden><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg></div>)}
          <div className="fr-step">
            <div className="fr-l">{s.label}</div>
            <div className="fr-n">{s.n.toLocaleString("en-US")}</div>
            <div className="fr-bar"><i style={{ width: `${s.bar}%`, minWidth: s.n ? 4 : 0 }} /></div>
            <div className="fr-p">{s.pct === null ? s.of : <><b>{s.pct}%</b>{s.of}</>}</div>
          </div>
        </Fragment>
      ))}
    </div>
  );
}
