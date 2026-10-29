// "On process": drivers the recruiters are bringing in. Read from every recruiter tab of
// each team's lead sheet (whether Crystal called them or not), plus leads given one of
// these statuses on the site.
import type { User } from "@prisma/client";
import { db } from "./db";
import { canonicalStatus } from "./recruiter-status";
import { tabForUser } from "./assignment";

export const ON_PROCESS = ["Need to bring", "Need approval", "Application"] as const;
const isProcess = (s: string | null) => !!s && (ON_PROCESS as readonly string[]).includes(s);

export interface ProcessRow { phoneE164: string; tab: string; status: string; name: string | null; experience: string | null }

/** The on-process rows of one sheet tab. */
export function processRowsOf(tab: string, headers: string[], rows: string[][], phoneOf: (raw: string) => string | null): ProcessRow[] {
  const col = (re: RegExp) => headers.findIndex((h) => re.test(h.trim()));
  const phoneI = col(/^phone$/i), statusI = col(/^status$/i);
  if (phoneI < 0 || statusI < 0 || /pool/i.test(tab)) return [];
  const nameI = col(/^(full |driver(?:'s)? )?name$/i), firstI = col(/^first ?name$/i), lastI = col(/^last ?name$/i), expI = col(/experience/i);
  const out: ProcessRow[] = [];
  for (const r of rows) {
    const status = canonicalStatus(r[statusI]);
    const phoneE164 = phoneOf(r[phoneI] ?? "");
    if (!phoneE164 || !isProcess(status)) continue;
    const name = (nameI >= 0 ? r[nameI] : [r[firstI] ?? "", r[lastI] ?? ""].join(" "))?.trim() || null;
    out.push({ phoneE164, tab: tab.slice(0, 100), status: status!, name: name?.slice(0, 120) ?? null, experience: expI >= 0 ? r[expI]?.trim().slice(0, 120) || null : null });
  }
  return out;
}

/** Replaces one team's on-process list with what its sheet shows now. Call only after a successful read. */
export async function saveProcessRows(orgId: string, rows: ProcessRow[], now = new Date()) {
  const byPhone = new Map(rows.map((r) => [r.phoneE164, r]));
  const old = new Map((await db.sheetDriver.findMany({ where: { orgId } })).map((r) => [r.phoneE164, r]));
  for (const r of byPhone.values()) {
    const o = old.get(r.phoneE164);
    await db.sheetDriver.upsert({
      where: { orgId_phoneE164: { orgId, phoneE164: r.phoneE164 } },
      create: { orgId, ...r, statusSince: now, seenAt: now },
      update: { ...r, seenAt: now, statusSince: o && o.status === r.status ? o.statusSince : now },
    });
  }
  const gone = [...old.keys()].filter((p) => !byPhone.has(p));
  if (gone.length) await db.sheetDriver.deleteMany({ where: { orgId, phoneE164: { in: gone } } });
}

export interface OnProcessDriver {
  key: string; leadId: string | null; name: string; phone: string; status: string; tab: string | null;
  recruiter: string | null; recruiterId: string | null; experience: string; documents: string | null; since: Date | null;
}

/**
 * A recruiter's own on-process drivers (their sheet tab, or leads assigned to them),
 * or every recruiter's for a manager.
 */
export async function loadOnProcess(user: Pick<User, "id" | "role" | "orgId">): Promise<OnProcessDriver[]> {
  const [sheet, users] = await Promise.all([
    db.sheetDriver.findMany({ where: { orgId: user.orgId } }),
    db.user.findMany({ where: { orgId: user.orgId, active: true }, select: { id: true, name: true, sheetTab: true } }),
  ]);
  const leads = await db.lead.findMany({
    where: { orgId: user.orgId, isDemo: false, OR: [{ phoneE164: { in: sheet.map((s) => s.phoneE164) } }, { recruiterStatus: { in: [...ON_PROCESS] } }] },
    select: { id: true, firstName: true, lastName: true, phoneE164: true, recruiterStatus: true, recruiterStatusAt: true, documentStatus: true, assignedTo: { select: { id: true, name: true } }, screening: { where: { key: "experience_years" }, select: { reportedValue: true, verifiedValue: true } } },
  });
  const tabs = [...new Set(sheet.map((s) => s.tab))];
  const ownerOf = new Map<string, { id: string; name: string } | null>();
  for (const t of tabs) {
    const owners = users.filter((u) => tabForUser(u, tabs)?.toLowerCase() === t.toLowerCase());
    ownerOf.set(t.toLowerCase(), owners.length === 1 ? owners[0] : null);
  }
  const leadByPhone = new Map(leads.map((l) => [l.phoneE164, l]));
  const exp = (l: (typeof leads)[number] | undefined) => l?.screening[0]?.verifiedValue || l?.screening[0]?.reportedValue || "";
  const out: OnProcessDriver[] = sheet.map((s) => {
    const l = leadByPhone.get(s.phoneE164);
    const owner = ownerOf.get(s.tab.toLowerCase()) ?? null;
    return {
      key: `sheet:${s.id}`, leadId: l?.id ?? null, name: s.name || (l ? [l.firstName, l.lastName].filter(Boolean).join(" ") : "") || "(no name)",
      phone: s.phoneE164, status: s.status, tab: s.tab, recruiter: owner?.name ?? s.tab, recruiterId: owner?.id ?? null,
      experience: exp(l) || s.experience || "", documents: l?.documentStatus.toLowerCase() ?? null, since: s.statusSince,
    };
  });
  // Statuses set on the site for drivers who are not in a sheet tab with one.
  const inSheet = new Set(sheet.map((s) => s.phoneE164));
  for (const l of leads) {
    if (!isProcess(l.recruiterStatus) || inSheet.has(l.phoneE164)) continue;
    out.push({
      key: `lead:${l.id}`, leadId: l.id, name: [l.firstName, l.lastName].filter(Boolean).join(" ") || "(no name)", phone: l.phoneE164,
      status: l.recruiterStatus!, tab: null, recruiter: l.assignedTo?.name ?? null, recruiterId: l.assignedTo?.id ?? null,
      experience: exp(l), documents: l.documentStatus.toLowerCase(), since: l.recruiterStatusAt,
    });
  }
  const mine = user.role === "ADMIN" ? out : out.filter((d) => d.recruiterId === user.id);
  return mine.sort((a, b) => (b.since?.getTime() ?? 0) - (a.since?.getTime() ?? 0));
}
