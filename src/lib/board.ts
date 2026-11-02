// The Board: every recruiter tab's drivers by their status in the lead sheet, with how long
// each has sat there. A recruiter sees their own tab, a manager the whole team, the owner
// every team. Statuses come from the sheet (read every 15 minutes); the board only reads.
import type { User } from "@prisma/client";
import { db } from "./db";
import { tabForUser } from "./assignment";

const H = 3600_000, D = 24 * H;

/** The columns, in the sheet's order, and when a driver counts as slow (warn) or stuck (late). */
export const BOARD_COLUMNS = [
  { status: "New", warn: 12 * H, late: 24 * H, lateText: (n: number) => `${n} untouched 24h+` },
  { status: "Call back", warn: 1 * D, late: 2 * D, lateText: (n: number) => `${n} waiting 2d+` },
  { status: "Need to talk", warn: 1 * D, late: 2 * D, lateText: (n: number) => `${n} waiting 2d+` },
  { status: "Need teammate", warn: 3 * D, late: 7 * D, lateText: (n: number) => `${n} waiting 7d+` },
  { status: "Need to bring", warn: 3 * D, late: 5 * D, lateText: (n: number) => `${n} stuck 5d+` },
  { status: "Need approval", warn: 2 * D, late: 3 * D, lateText: (n: number) => `${n} stuck 3d+` },
  { status: "Application", warn: 5 * D, late: 7 * D, lateText: (n: number) => `${n} stuck 7d+` },
  { status: "Hired", warn: Infinity, late: Infinity, lateText: () => "" },
] as const;

// New leads older than this are not "new" any more; Hired shows the last 30 days.
const NEW_WINDOW = 30 * D, HIRED_WINDOW = 30 * D;

export type Tone = "ok" | "warn" | "late";
export interface BoardDriver {
  key: string; leadId: string | null; name: string; phone: string; status: string; tab: string;
  recruiter: string | null; recruiterId: string | null; team: string; since: string; ageMs: number; tone: Tone; detail: string;
}
export interface BoardColumn { status: string; drivers: BoardDriver[]; late: number; lateText: string; avgMs: number | null }

export function toneOf(status: string, ageMs: number): Tone {
  const c = BOARD_COLUMNS.find((x) => x.status === status);
  if (!c) return "ok";
  return ageMs >= c.late ? "late" : ageMs >= c.warn ? "warn" : "ok";
}

const DOCS: Record<string, string> = { RECEIVED: "CDL/med card in", REQUESTED: "docs asked", EXPIRED: "docs expired" };

/**
 * The board for the given teams. `recruiterId` keeps one recruiter's tab only (a recruiter
 * always gets their own). Drivers are sorted stuck first, then the longest waiting.
 */
export async function loadBoard(user: Pick<User, "id" | "role">, orgIds: string[], recruiterId?: string, now = new Date()): Promise<{ columns: BoardColumn[]; recruiters: { id: string; name: string; n: number }[] }> {
  const statuses = BOARD_COLUMNS.map((c) => c.status as string);
  const [rows, users, orgs] = await Promise.all([
    db.sheetRow.findMany({ where: { orgId: { in: orgIds }, status: { in: statuses } } }),
    db.user.findMany({ where: { orgId: { in: orgIds }, active: true }, select: { id: true, name: true, sheetTab: true, orgId: true } }),
    db.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }),
  ]);
  // Which login owns which tab, per team (same rule as assignment: the tab named like the user).
  const owner = new Map<string, { id: string; name: string } | null>();
  for (const orgId of orgIds) {
    const tabs = [...new Set(rows.filter((r) => r.orgId === orgId).map((r) => r.tab))];
    for (const t of tabs) {
      const o = users.filter((u) => u.orgId === orgId && tabForUser(u, tabs)?.toLowerCase() === t.toLowerCase());
      owner.set(`${orgId}|${t.toLowerCase()}`, o.length === 1 ? o[0] : null);
    }
  }
  const leads = await db.lead.findMany({
    where: { orgId: { in: orgIds }, isDemo: false, phoneE164: { in: [...new Set(rows.map((r) => r.phoneE164))] } },
    select: { id: true, orgId: true, phoneE164: true, firstName: true, lastName: true, documentStatus: true },
  });
  const lead = new Map(leads.map((l) => [`${l.orgId}|${l.phoneE164}`, l]));
  const teamName = new Map(orgs.map((o) => [o.id, o.name]));

  const all: BoardDriver[] = [];
  for (const r of rows) {
    if (/pool/i.test(r.tab) && r.status !== "New") continue;
    const since = r.statusAt ?? r.appliedAt ?? r.seenAt;
    const ageMs = Math.max(0, now.getTime() - since.getTime());
    if (r.status === "New" && now.getTime() - (r.appliedAt ?? since).getTime() > NEW_WINDOW) continue;
    if (r.status === "Hired" && ageMs > HIRED_WINDOW) continue;
    const o = owner.get(`${r.orgId}|${r.tab.toLowerCase()}`) ?? null;
    const l = lead.get(`${r.orgId}|${r.phoneE164}`);
    const name = r.name || (l ? [l.firstName, l.lastName].filter(Boolean).join(" ") : "") || "(no name)";
    all.push({
      key: r.id, leadId: l?.id ?? null, name, phone: r.phoneE164, status: r.status, tab: r.tab,
      recruiter: o?.name ?? (/pool/i.test(r.tab) ? null : r.tab), recruiterId: o?.id ?? null, team: teamName.get(r.orgId) ?? "",
      since: since.toISOString(), ageMs, tone: toneOf(r.status, ageMs),
      detail: [r.experience, l ? DOCS[l.documentStatus] : null].filter(Boolean).join(" · "),
    });
  }
  const recruiters = [...new Map(all.filter((d) => d.recruiter).map((d) => [d.recruiterId ?? `tab:${d.recruiter}`, d.recruiter!])).entries()]
    .map(([id, name]) => ({ id, name, n: all.filter((d) => (d.recruiterId ?? `tab:${d.recruiter}`) === id).length }))
    .sort((a, b) => b.n - a.n);
  const pick = user.role === "ADMIN" ? recruiterId : user.id;
  const shown = pick ? all.filter((d) => (d.recruiterId ?? `tab:${d.recruiter}`) === pick) : all;
  const rank: Record<Tone, number> = { late: 0, warn: 1, ok: 2 };
  const columns = BOARD_COLUMNS.map((c) => {
    const drivers = shown.filter((d) => d.status === c.status)
      .sort((a, b) => c.status === "Hired" ? a.ageMs - b.ageMs : rank[a.tone] - rank[b.tone] || b.ageMs - a.ageMs);
    const late = drivers.filter((d) => d.tone === "late").length;
    return {
      status: c.status, drivers, late, lateText: late ? c.lateText(late) : "",
      avgMs: drivers.length ? drivers.reduce((s, d) => s + d.ageMs, 0) / drivers.length : null,
    };
  });
  return { columns, recruiters };
}

