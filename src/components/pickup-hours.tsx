// The "When drivers pick up" card: one box per US Central weekday and hour, darker = a
// bigger share of Crystal's calls became a talk. A box with too few calls stays empty.
import { Card } from "./ui";
import { MIN_CALLS, hourLabel, type HourBox, type PickupHours } from "@/lib/pickup-hours";

const STEPS = ["under 5%", "5–9%", "10–14%", "15–19%", "20% or more"];
const DAY_NAME: Record<string, string> = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
const n = (x: number) => x.toLocaleString("en-US");
const callsText = (x: number) => `${n(x)} call${x === 1 ? "" : "s"}`;

function boxTitle(day: string, b: HourBox) {
  const when = `${DAY_NAME[day]} ${hourLabel(b.hour)}`;
  if (!b.calls) return `${when}: no calls`;
  const what = `${when}: ${callsText(b.calls)}, ${n(b.talks)} became a talk`;
  return b.pct === null ? `${what} (too few calls for a percent)` : `${what} (${b.pct}%)`;
}

export function PickupHoursCard({ data }: { data: PickupHours }) {
  const { hours, rows } = data;
  const span = `${hourLabel(hours[0])} and ${hourLabel(hours[hours.length - 1] + 1)}`;
  return (
    <Card title="When drivers pick up" right={<span className="small muted">US Central time</span>}>
      {data.filled ? (
        <>
          <div className="table-scroll">
            <div className="pu-grid" role="table" aria-label="Share of Crystal's calls that became a talk, by day and hour"
              style={{ gridTemplateColumns: `52px repeat(${hours.length}, minmax(0, 1fr))`, minWidth: 52 + hours.length * 60 }}>
              <div className="pu-row" role="row">
                <span role="columnheader" />
                {hours.map((h) => <span key={h} className="pu-h" role="columnheader">{hourLabel(h)}</span>)}
              </div>
              {rows.map((r) => (
                <div className="pu-row" role="row" key={r.day}>
                  <span className="pu-d" role="rowheader">{r.day}</span>
                  {r.boxes.map((b) => (
                    <div key={b.hour} className={`pu-c pu-${b.step}`} role="cell" title={boxTitle(r.day, b)}>
                      {b.pct !== null && <><b>{b.pct}%</b><span>{n(b.talks)} of {n(b.calls)}</span></>}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
          <div className="pu-legend">
            <span>Became a talk:</span>
            {STEPS.map((label, i) => <span key={label}><i className={`pu-${i + 1}`} />{label}</span>)}
            <span><i className="pu-0" />fewer than {MIN_CALLS} calls, not shown</span>
          </div>
          <p className="small muted" style={{ margin: "12px 0 0" }}>
            Crystal&apos;s calls in these dates, by the day and hour she placed them: {callsText(data.calls)} between {span}, {n(data.talks)} became a talk
            {data.outside ? `; ${callsText(data.outside)} outside these hours ${data.outside === 1 ? "is" : "are"} not in the table` : ""}.
            {" "}New leads pick up more often than re-calls, so a box also depends on who was called then.
          </p>
        </>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          {data.all.calls
            ? `No day and hour has ${MIN_CALLS} calls in these dates yet: Crystal placed ${callsText(data.all.calls)}, ${n(data.all.talks)} became a talk. Pick a longer period to see when drivers pick up.`
            : "Crystal placed no calls in these dates."}
        </p>
      )}
    </Card>
  );
}
