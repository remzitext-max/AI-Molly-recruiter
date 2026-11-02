import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { keepQuery, teamView } from "@/lib/dashboard-view";
import { loadBoard } from "@/lib/board";
import { PageHead } from "@/components/ui";
import { BoardStrip } from "@/components/board-strip";
import { LeadPopup } from "@/components/lead-popup";

/**
 * The Board: one card per lead sheet status with its number of drivers and how many are
 * stuck. A card opens the list of those drivers, a driver opens their profile.
 */
export default async function Board({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const manager = user.role === "ADMIN";
  const view = manager ? await teamView(user, sp.team) : { owner: false, orgs: [], orgIds: [user.orgId], team: user.orgId, teamName: "" };
  const { columns, recruiters } = await loadBoard(user, view.orgIds, manager ? sp.r : undefined);
  const total = columns.reduce((n, c) => n + c.drivers.length, 0);
  const late = columns.reduce((n, c) => n + c.late, 0);
  const base = Object.fromEntries(Object.entries(sp).filter(([k]) => k !== "r"));

  return (
    <>
      <PageHead
        title={manager ? `Board · ${view.teamName}` : "My board"}
        sub={<>{total} drivers{late > 0 && <> · <span className="bad-text">{late} stuck</span></>} · statuses from the lead sheet, updated every 15 minutes</>}
        right={view.owner && view.orgs.length > 1 ? (
          <div className="tabs" style={{ margin: 0 }}>
            <Link href={keepQuery("/board", base, "team", "all")} className={`tab ${view.team === "all" ? "on" : ""}`}>All teams</Link>
            {view.orgs.map((o) => <Link key={o.id} href={keepQuery("/board", base, "team", o.id)} className={`tab ${view.team === o.id ? "on" : ""}`}>{o.name}</Link>)}
          </div>
        ) : undefined}
      />
      {manager && recruiters.length > 1 && (
        <div className="board-pills">
          <Link href={`/board?${new URLSearchParams(base as Record<string, string>)}`} className={`pill ${!sp.r ? "on" : ""}`}>All</Link>
          {recruiters.map((r) => <Link key={r.id} href={keepQuery("/board", sp, "r", r.id)} className={`pill ${sp.r === r.id ? "on" : ""}`}>{r.name} <span className="muted">{r.n}</span></Link>)}
        </div>
      )}
      <BoardStrip columns={columns} showRecruiter={manager} />
      <p className="small muted" style={{ marginTop: 14 }}>
        Click a status to see its drivers, then a driver for their profile. Red = stuck (New untouched 24h+, Call back 2 days+, Need to bring 5 days+, Need approval 3 days+, Application 7 days+), yellow = getting slow. New, Call back, Need to talk and Need teammate show drivers who applied in the last 30 days; Hired the last 30 days.
      </p>
      <LeadPopup />
    </>
  );
}
