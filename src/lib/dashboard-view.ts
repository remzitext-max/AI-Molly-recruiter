// What a dashboard page covers: the period (?from=&to= days in Central time, or an older
// ?range= link) and, for the owner, which team (?team=all or a team id).
import { DateTime } from "luxon";
import type { User } from "@prisma/client";
import { db } from "./db";
import { isOwner } from "./auth";

// Day buckets and "today" follow US Central time.
export const ZONE = "America/Chicago";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function period(sp: Record<string, string | undefined>, now = DateTime.now().setZone(ZONE)) {
  const today = now.startOf("day");
  let from = today.minus({ days: 6 }), to = today;
  if (sp.from && DAY.test(sp.from)) {
    from = DateTime.fromISO(sp.from, { zone: ZONE });
    to = sp.to && DAY.test(sp.to) ? DateTime.fromISO(sp.to, { zone: ZONE }) : from;
    if (to < from) [from, to] = [to, from];
    if (to > today) to = today;
    if (from > today) from = today;
  } else if (sp.range === "today") from = today;
  else if (sp.range === "30d") from = today.minus({ days: 29 });
  const days = Math.round(to.diff(from, "days").days) + 1;
  const label = days === 1 ? (+to === +today ? "Today" : +to === +today.minus({ days: 1 }) ? "Yesterday" : to.toFormat("MMM d")) : +to === +today && [7, 14, 30].includes(days) ? `Last ${days} days` : `${days} days`;
  // The period ends now for today, so "vs previous" compares the same length of time.
  const end = +to === +today ? now : to.plus({ days: 1 });
  const since = from.toJSDate(), until = end.toJSDate();
  return {
    now, from, to, days, label, since, until,
    range: { gte: since, lt: until },
    prev: { gte: new Date(since.getTime() - (until.getTime() - since.getTime())), lt: since },
    text: days === 1 ? to.toFormat("ccc, MMM d") : `${from.toFormat("MMM d")} – ${to.toFormat("MMM d")}`,
  };
}
export type Period = ReturnType<typeof period>;

export interface TeamView { owner: boolean; orgs: { id: string; name: string }[]; orgIds: string[]; team: string; teamName: string }

/** A manager sees their team; the owner every team ("all", the default) or one of them. */
export async function teamView(user: Pick<User, "role" | "orgId">, team?: string): Promise<TeamView> {
  const owner = await isOwner(user);
  if (!owner) {
    const org = await db.organization.findUnique({ where: { id: user.orgId }, select: { id: true, name: true } });
    return { owner, orgs: org ? [org] : [], orgIds: [user.orgId], team: user.orgId, teamName: org?.name ?? "" };
  }
  const orgs = await db.organization.findMany({ orderBy: [{ isMain: "desc" }, { createdAt: "asc" }], select: { id: true, name: true } });
  const one = orgs.find((o) => o.id === team);
  return one
    ? { owner, orgs, orgIds: [one.id], team: one.id, teamName: one.name }
    : { owner, orgs, orgIds: orgs.map((o) => o.id), team: "all", teamName: "All teams" };
}

export const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

/** The same page with one query value changed. */
export function keepQuery(path: string, sp: Record<string, string | undefined>, k: string, v: string) {
  const q = new URLSearchParams(Object.entries(sp).filter(([, x]) => x) as [string, string][]);
  q.set(k, v);
  return `${path}?${q}`;
}
