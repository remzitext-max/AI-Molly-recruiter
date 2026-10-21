// Meta Graph API: lead ad details (which campaign / ad / form a lead came from),
// ad spend per campaign, and Conversions API events for lead ads ("conversion
// leads"), so Facebook learns which leads became good drivers.
// Field names follow Meta's Graph API docs; not yet verified with this account.
import crypto from "node:crypto";
import { config } from "../../lib/config";
import { providerFetch } from "./http";

const base = () => `https://graph.facebook.com/${config.meta.graphVersion}`;

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  const q = new URLSearchParams({ ...params, access_token: config.meta.accessToken ?? "" });
  const res = await providerFetch(path.startsWith("https://") ? path : `${base()}${path}?${q}`, { timeoutMs: 30_000 });
  return (await res.json()) as T;
}

type Page<T> = { data?: T[]; paging?: { next?: string } };

async function all<T>(path: string, params: Record<string, string>, max = 2000): Promise<T[]> {
  const out: T[] = [];
  let page = await get<Page<T>>(path, params);
  for (;;) {
    out.push(...(page.data ?? []));
    if (!page.paging?.next || out.length >= max) return out;
    page = await get<Page<T>>(page.paging.next, {});
  }
}

export interface MetaLead { id: string; created_time: string; phone: string | null; campaign_name?: string; ad_name?: string; form_name?: string }

/** Leads from every lead form on the page since a time. */
export async function listMetaLeads(since: Date): Promise<MetaLead[]> {
  const forms = await all<{ id: string; name: string }>(`/${config.meta.pageId}/leadgen_forms`, { fields: "id,name", limit: "100" });
  const out: MetaLead[] = [];
  for (const f of forms) {
    const leads = await all<{ id: string; created_time: string; field_data?: { name: string; values: string[] }[]; campaign_name?: string; ad_name?: string }>(`/${f.id}/leads`, {
      fields: "id,created_time,field_data,campaign_name,ad_name",
      filtering: JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: Math.floor(since.getTime() / 1000) }]),
      limit: "200",
    });
    for (const l of leads) {
      const phone = l.field_data?.find((d) => /phone/i.test(d.name))?.values?.[0] ?? null;
      out.push({ id: l.id, created_time: l.created_time, phone, campaign_name: l.campaign_name, ad_name: l.ad_name, form_name: f.name });
    }
  }
  return out;
}

export interface CampaignSpend { campaign_id: string; campaign_name: string; spend: number }

/** Ad spend per campaign for a date range (YYYY-MM-DD, ad account's timezone). */
export async function campaignSpend(since: string, until: string): Promise<CampaignSpend[]> {
  const rows = await all<{ campaign_id: string; campaign_name: string; spend?: string }>(`/${config.meta.adAccountId}/insights`, {
    level: "campaign", fields: "campaign_id,campaign_name,spend", time_range: JSON.stringify({ since, until }), limit: "500",
  });
  return rows.map((r) => ({ campaign_id: r.campaign_id, campaign_name: r.campaign_name, spend: Number(r.spend ?? 0) }));
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** One CRM stage event for a lead ad lead (Conversions API, action_source system_generated). */
export async function sendLeadEvent(e: { eventName: string; time: Date; fbLeadId?: string | null; phoneE164: string; eventId: string }) {
  const userData: Record<string, unknown> = { ph: [sha(e.phoneE164.replace(/\D/g, ""))] };
  if (e.fbLeadId) userData.lead_id = e.fbLeadId;
  const res = await providerFetch(`${base()}/${config.meta.datasetId}/events?access_token=${encodeURIComponent(config.meta.accessToken ?? "")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    timeoutMs: 30_000,
    body: JSON.stringify({
      data: [{
        event_name: e.eventName, event_time: Math.floor(e.time.getTime() / 1000), event_id: e.eventId, action_source: "system_generated",
        user_data: userData, custom_data: { event_source: "crm", lead_event_source: "Crystal AI" },
      }],
    }),
  });
  return (await res.json()) as { events_received?: number };
}
