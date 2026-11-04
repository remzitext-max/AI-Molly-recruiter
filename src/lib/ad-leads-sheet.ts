// YouTube / TikTok leads copied into their own Google Sheet (AD_LEADS_SHEET_ID),
// one row each, with a Source column so recruiters see where the driver came from.
import { config } from "./config";
import { getAdapters } from "../adapters/registry";
import { log } from "./redact";
import type { AdLead } from "./ad-leads";

export const AD_LEAD_HEADER = ["Received (Central)", "Source", "Name", "Phone", "Email", "State", "Solo / Team", "Experience", "CDL", "SAP", "Campaign", "Ad", "Lead ID", "Crystal"];

function pick(a: Record<string, string>, ...re: RegExp[]) {
  for (const r of re) for (const [k, v] of Object.entries(a)) if (r.test(k) && v.trim()) return v.trim();
  return "";
}

export function sourceLabel(sourceSystem: string) {
  return sourceSystem === "TIKTOK" ? "TikTok" : sourceSystem === "GOOGLE_ADS" ? "YouTube" : "Ad";
}

/** The sheet row for a lead. Exported for tests. */
export function adLeadRow(p: AdLead, crystal: string, at = new Date()): string[] {
  const l = p.lead;
  const a = p.answers;
  const when = at.toLocaleString("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  return [
    when, sourceLabel(l.sourceSystem), [l.firstName, l.lastName].filter(Boolean).join(" "), l.phone ?? "", l.email ?? "", l.state ?? "",
    pick(a, /^position$/, /solo|team|driver_type/), pick(a, /experience|years/), pick(a, /cdl/), pick(a, /sap/, /drug|alcohol|clearinghouse/),
    l.fb?.campaign ?? "", l.fb?.ad ?? "", l.fb?.leadId ?? "", crystal,
  ];
}

export async function appendAdLeadRow(row: string[]) {
  const sheetId = config.adLeadsSheetId;
  const sheets = getAdapters().sheets;
  if (!sheetId) return;
  if (!sheets.appendRow) { log.info("ad lead sheet: demo mode, row not written", { source: row[1] }); return; }
  await sheets.appendRow(sheetId, AD_LEAD_HEADER, row);
}
