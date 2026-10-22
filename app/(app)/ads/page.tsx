import Link from "next/link";
import { DateTime } from "luxon";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { config } from "@/lib/config";
import { campaignSpend, type CampaignSpend } from "@/adapters/live/meta";
import { metaEventsConfigured, metaLeadsConfigured, metaSpendConfigured } from "@/lib/meta";
import { Badge, Card, PageHead, fmt } from "@/components/ui";

// Facebook lead ads: spend and cost per lead / driver by campaign. Admins only.
const ZONE = "America/Chicago";
const RANGES = { "7d": "Last 7 days", "30d": "Last 30 days", month: "This month", last: "Last month" } as const;
type Range = keyof typeof RANGES;
const INTERESTED_UP = ["INTERESTED", "DOCS_REQUESTED", "DOCS_RECEIVED", "HANDOFF_READY", "HANDED_OFF"];
const money = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);
const per = (spend: number | null, n: number) => (spend !== null && n ? spend / n : null);

export default async function Ads({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireAdmin();
  const sp = await searchParams;
  const range: Range = sp.range && sp.range in RANGES ? (sp.range as Range) : "30d";
  const now = DateTime.now().setZone(ZONE);
  const [start, end] =
    range === "7d" ? [now.startOf("day").minus({ days: 6 }), now] :
    range === "30d" ? [now.startOf("day").minus({ days: 29 }), now] :
    range === "month" ? [now.startOf("month"), now] :
    [now.minus({ months: 1 }).startOf("month"), now.startOf("month").minus({ milliseconds: 1 })];

  const leads = await db.lead.findMany({
    where: { isDemo: false, createdAt: { gte: start.toJSDate(), lte: end.toJSDate() } },
    select: { fbCampaign: true, fbLeadId: true, pipelineStatus: true, documentStatus: true, hireStage: true, _count: { select: { calls: { where: { status: "COMPLETED" } } } } },
  });
  let spend: CampaignSpend[] = [];
  let spendError: string | null = null;
  if (metaSpendConfigured()) {
    try { spend = await campaignSpend(start.toISODate()!, end.toISODate()!); } catch (e) { spendError = (e as Error).message.slice(0, 300); }
  }
  const sync = await db.sourceConnection.findUnique({ where: { id: "meta-leads" } });

  // Facebook's CPL divides spend by every team's leads (as Ads Manager does). This team's cost is
  // its own leads at that CPL, so later stages (interested, CDL) are priced from the same base.
  const names = new Set<string>([...spend.map((s) => s.campaign_name), ...leads.map((l) => l.fbCampaign ?? "")]);
  const fb = { spend: spend.reduce((n, s) => n + s.spend, 0), leads: spend.reduce((n, s) => n + s.leads, 0) };
  const fbCpl = spend.length ? per(fb.spend, fb.leads) : null;
  const rows = [...names].map((name) => {
    const ls = leads.filter((l) => (l.fbCampaign ?? "") === name);
    const camp = spend.filter((s) => s.campaign_name === name);
    const known = name !== "" && camp.length > 0;
    const cSpend = camp.reduce((n, s) => n + s.spend, 0);
    const cLeads = camp.reduce((n, s) => n + s.leads, 0);
    const cpl = known ? per(cSpend, cLeads) : name === "" ? fbCpl : null;
    return {
      name: name || "Not matched to a campaign yet", spend: known ? cSpend : null, fbLeads: known ? cLeads : null, cpl,
      leads: ls.length, answered: ls.filter((l) => l._count.calls > 0).length,
      interested: ls.filter((l) => INTERESTED_UP.includes(l.pipelineStatus)).length,
      docs: ls.filter((l) => l.documentStatus === "RECEIVED").length,
      qualified: ls.filter((l) => ["HANDOFF_READY", "HANDED_OFF"].includes(l.pipelineStatus)).length,
      hired: ls.filter((l) => l.hireStage === "HIRED").length,
      ours: cpl !== null ? cpl * ls.length : null,
    };
  }).sort((a, b) => (b.spend ?? -1) - (a.spend ?? -1) || b.leads - a.leads);
  const total = {
    spend: spend.length ? fb.spend : null,
    ours: spend.length ? rows.reduce((n, r) => n + (r.ours ?? 0), 0) : null,
    leads: leads.length, interested: leads.filter((l) => INTERESTED_UP.includes(l.pipelineStatus)).length,
    docs: leads.filter((l) => l.documentStatus === "RECEIVED").length, qualified: leads.filter((l) => ["HANDOFF_READY", "HANDED_OFF"].includes(l.pipelineStatus)).length,
    hired: leads.filter((l) => l.hireStage === "HIRED").length,
  };

  return (
    <>
      <PageHead
        title="Facebook ads"
        sub={`Spend and cost per lead and driver by campaign · ${start.toFormat("MMM d")} – ${end.toFormat("MMM d")} · admins only, never sent to Telegram`}
        right={<div className="tabs" style={{ margin: 0 }}>{(Object.keys(RANGES) as Range[]).map((r) => <Link key={r} href={`/ads?range=${r}`} className={`tab ${r === range ? "on" : ""}`}>{RANGES[r]}</Link>)}</div>}
      />
      <div className="stats four">
        <div className="stat"><div className="l">Ad spend (all teams)</div><div className="n">{money(total.spend)}</div><div className="d">{metaSpendConfigured() ? `${fb.leads} Facebook leads` : "connect Meta to see spend"}</div></div>
        <div className="stat"><div className="l">Cost per lead</div><div className="n">{money(fbCpl)}</div><div className="d">as in Ads Manager</div></div>
        <div className="stat"><div className="l">This team&apos;s leads</div><div className="n">{total.leads}</div><div className="d">{total.ours !== null ? `${money(total.ours)} of the spend` : "leads Crystal received"}</div></div>
        <div className="stat"><div className="l">Cost per interested driver</div><div className="n">{money(per(total.ours, total.interested))}</div><div className="d">{total.interested} interested</div></div>
        <div className="stat"><div className="l">Cost per CDL received</div><div className="n">{money(per(total.ours, total.docs))}</div><div className="d">{total.docs} sent CDL</div></div>
        <div className="stat"><div className="l">Cost per qualified driver</div><div className="n">{money(per(total.ours, total.qualified))}</div><div className="d">{total.qualified} handed to recruiter</div></div>
        <div className="stat"><div className="l">Cost per hire</div><div className="n">{money(per(total.ours, total.hired))}</div><div className="d">{total.hired} hired from leads in this period (marked on the lead page)</div></div>
      </div>
      {spendError && <div className="alert error">Could not read spend from Meta: {spendError}</div>}
      <Card title="By campaign" flush>
        <table>
          <thead><tr><th>Campaign</th><th className="num">Spend</th><th className="num">FB leads</th><th className="num">CPL</th><th className="num">Our leads</th><th className="num">Answered</th><th className="num">Interested</th><th className="num">CDL in</th><th className="num">Qualified</th><th className="num">Hired</th><th className="num">Per interested</th><th className="num">Per CDL</th><th className="num">Per hire</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td><td className="num">{money(r.spend)}</td><td className="num">{r.fbLeads ?? "—"}</td><td className="num">{money(r.cpl)}</td>
                <td className="num">{r.leads}</td><td className="num">{r.answered}</td><td className="num">{r.interested}</td><td className="num">{r.docs}</td><td className="num">{r.qualified}</td><td className="num">{r.hired}</td>
                <td className="num">{money(per(r.ours, r.interested))}</td><td className="num">{money(per(r.ours, r.docs))}</td><td className="num">{money(per(r.ours, r.hired))}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={13} className="muted">No leads or spend in this period.</td></tr>}
          </tbody>
        </table>
      </Card>
      <Card title="Connection">
        <table className="kv"><tbody>
          <tr><th>Lead ad details</th><td>{metaLeadsConfigured() ? <Badge v="configured" /> : <Badge v="missing_credentials" />} <span className="small muted">META_ACCESS_TOKEN + META_PAGE_ID · matches each lead to its campaign by phone every 15 min{sync?.lastSyncAt ? ` · last sync ${fmt(sync.lastSyncAt)}` : ""}{sync?.lastError ? ` · error: ${sync.lastError}` : ""}</span></td></tr>
          <tr><th>Ad spend</th><td>{metaSpendConfigured() ? <Badge v="configured" /> : <Badge v="missing_credentials" />} <span className="small muted">META_AD_ACCOUNT_ID</span></td></tr>
          <tr><th>Send results to Facebook</th><td>{metaEventsConfigured() ? <Badge v="configured" /> : <Badge v="missing_credentials" />} <span className="small muted">META_DATASET_ID · sends Interested, Documents received, Qualified and Hired for each lead so Facebook finds more drivers like them</span></td></tr>
        </tbody></table>
        <p className="small muted" style={{ marginBottom: 0 }}>Graph API {config.meta.graphVersion}. The token needs leads_retrieval, ads_read, pages_show_list, pages_read_engagement, pages_manage_ads and ads_management (for the dataset).</p>
      </Card>
    </>
  );
}
