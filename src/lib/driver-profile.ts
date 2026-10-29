// One driver's profile (anketa) in plain strings: shown in the Leads popup and
// written to the downloadable PDF, so both always say the same thing.
import { DateTime } from "luxon";
import { db } from "./db";
import { leadScope } from "./rbac";
import { config } from "./config";
import { getSettings } from "./settings";
import { answersOf, fitRulesFrom, fitScore, fitTone } from "./fit-score";
import { endedByText, whoEnded } from "./call-end";
import { HIRE_LABEL } from "./hiring";
import { recordEvent } from "./activity";
import { formatLocal } from "./timezone";
import { officeClock } from "./office-hours";

type Viewer = Parameters<typeof leadScope>[0];
export type Row = [label: string, value: string];

export interface DriverProfile {
  id: string;
  name: string;
  initials: string;
  phone: string;
  email: string;
  location: string;
  source: string;
  applied: string;
  recruiter: string;
  status: string;
  hiring: string | null;
  fit: { text: string; tone: string };
  driver: Row[];
  deal: Row[];
  employers: string[];
  summary: string | null;
  calls: { id: string; when: string; length: string; result: string; endedBy: string; recording: boolean }[];
  documents: { id: string; kind: string; when: string; read: string }[];
  timeline: { when: string; who: string; what: string }[];
  /** Current values for the edit form, keyed like PROFILE_FIELDS and BASIC_FIELDS. */
  edit: Record<string, string>;
}

import { BASIC_FIELDS, PROFILE_FIELDS } from "./profile-fields";
export { BASIC_FIELDS, PROFILE_FIELDS };

const TZ = "America/Chicago";
export const when = (d: Date | null | undefined) => (d ? DateTime.fromJSDate(d).setZone(TZ).toFormat("LLL d, h:mm a") : "");
const words = (s: string | null | undefined) => (s ?? "").replace(/_/g, " ").toLowerCase();

export function sourceLabel(s: string) {
  if (s === "GOOGLE_SHEETS") return "Google Sheet · Pool";
  if (s === "RECRUITER") return "Recruiter's own driver";
  if (s.startsWith("GOOGLE_SHEETS:")) {
    const gid = s.split(":")[1];
    const tab = config.googleSheets.extraTabs.find((t) => t.gid === gid);
    return `Google Sheet · ${tab ? tab.tag : `tab ${gid}`}`;
  }
  return s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");
}

/** "Swift 2023-now, Werner 2021-2023" -> one employer per line. */
export function splitEmployers(text: string | null | undefined): string[] {
  const t = text ?? "";
  // A recruiter's list is saved one employer per line, so "Swift, 2023 - now, OTR" stays whole.
  const sep = t.includes("\n") ? /\s*\n\s*/ : /\s*(?:;|,(?=\s*[A-Za-z]))\s*/;
  return t.split(sep).map((s) => s.trim()).filter(Boolean);
}

/** The profile of one lead the viewer may see, or null. */
export async function loadDriverProfile(user: Viewer, id: string): Promise<DriverProfile | null> {
  const l = await db.lead.findFirst({
    where: { id, ...leadScope(user) },
    include: {
      assignedTo: true, sourceRecords: true, screening: true,
      calls: { orderBy: { createdAt: "desc" }, take: 20 },
      documents: { where: { deletedAt: null }, orderBy: { uploadedAt: "desc" } },
      events: { orderBy: { createdAt: "desc" }, take: 60 },
    },
  });
  if (!l) return null;
  const answers = answersOf(l.screening);
  const a = (k: string) => (answers[k] ?? "").trim();
  const verified = new Set(l.screening.filter((f) => f.verifiedValue).map((f) => f.key));
  const val = (k: string) => (a(k) ? `${a(k)}${verified.has(k) ? " (by recruiter)" : ""}` : "");
  const position = l.sourceRecords.map((s) => (s.raw as { position?: string } | null)?.position).find(Boolean);
  const fit = fitScore(answers, fitRulesFrom((await getSettings()).fitRules));
  const name = [l.firstName, l.lastName].filter(Boolean).join(" ") || "(no name)";
  const summary = l.calls.find((c) => c.summary)?.summary ?? null;
  const userNames = new Map((await db.user.findMany({ where: { id: { in: [...new Set(l.events.map((e) => e.actorId).filter(Boolean) as string[])] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const who = (e: { actorType: string; actorId: string | null }) =>
    e.actorType === "USER" ? userNames.get(e.actorId ?? "") ?? "Recruiter" : e.actorType === "AI" ? `${config.agentPersona.name} AI` : e.actorType === "DRIVER" ? "Driver" : e.actorType === "PROVIDER" ? "Phone system" : "System";

  return {
    id: l.id,
    name,
    initials: (name.match(/\p{L}+/gu) ?? []).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?",
    phone: l.phoneE164,
    email: l.email ?? "",
    location: a("home_location") || [l.state, l.zip].filter(Boolean).join(" "),
    source: [...new Set(l.sourceRecords.map((s) => sourceLabel(s.sourceSystem)))].join(", "),
    applied: when(l.createdAt),
    recruiter: l.assignedTo?.name ?? "Unassigned",
    status: l.recruiterStatus ?? words(l.pipelineStatus),
    hiring: l.hireStage !== "NONE" ? HIRE_LABEL[l.hireStage] : null,
    fit: { text: fit.score === null ? fit.label : `${fit.score}/100 · ${fit.label}${fit.reasons.length ? `: ${fit.reasons.join("; ")}` : ""}`, tone: fitTone(fit) },
    driver: ([
      ["Driver type", a("driving_type") || (position ? position.charAt(0) + position.slice(1).toLowerCase() : "")],
      ["Experience", val("experience_years")],
      ["OTR / local", val("work_type")],
      ["Equipment", val("equipment_experience")],
      ["CDL class", val("cdl_class")],
      ["Endorsements", val("endorsements")],
      ["SAP program", val("sap_history")],
      ["Accidents", val("accident_details") || val("accidents_at_fault")],
      ["Medical card expires", val("med_card_expiry")],
      ["English", val("english_level")],
    ] as Row[]),
    deal: ([
      ["Rate expectation", val("rate_expectation")],
      ["Home time", val("home_time")],
      ["Can drive", val("weekly_miles")],
      ["Ready date", val("start_date")],
      ["Interest in offer", val("offer_interest")],
      ["Concerns", val("concerns")],
      ["Documents", words(l.documentStatus)],
      ["AI call attempts", String(l.attemptCount)],
      ["Recruiter call booked", l.recruiterCallAt ? `${formatLocal(l.recruiterCallAt, l.timezone)} (${officeClock(l.recruiterCallAt)} Tashkent)` : ""],
    ] as Row[]),
    employers: splitEmployers(a("recent_companies")),
    summary,
    calls: l.calls.map((c) => ({
      id: c.id,
      when: when(c.createdAt),
      length: c.startedAt && c.endedAt ? `${Math.round((c.endedAt.getTime() - c.startedAt.getTime()) / 1000)} sec` : "",
      result: c.provider === "recruiter-upload" ? `Recording uploaded by ${(c.metrics as { uploadedBy?: string } | null)?.uploadedBy ?? "recruiter"}` : [words(c.status), words(c.outcome)].filter(Boolean).join(" · "),
      endedBy: endedByText(whoEnded(c), config.agentPersona.name) ?? "",
      recording: !!c.recordingKey,
    })),
    documents: l.documents.map((d) => {
      const fields = ((d.extraction as { fields?: { name: string; value: string | null }[] } | null)?.fields ?? []).filter((f) => f.value);
      return { id: d.id, kind: d.kind === "MED_CARD" ? "Medical card" : "CDL", when: when(d.uploadedAt), read: fields.map((f) => `${words(f.name)} ${f.value}`).join(" · ") };
    }),
    timeline: l.events.map((e) => ({ when: when(e.createdAt), who: who(e), what: e.message })),
    edit: {
      ...Object.fromEntries(PROFILE_FIELDS.map((f) => [f.key, f.key === "recent_companies" ? splitEmployers(a(f.key)).join("\n") : f.key === "accident_details" ? a(f.key) || a("accidents_at_fault") : a(f.key)])),
      firstName: l.firstName ?? "", lastName: l.lastName ?? "", email: l.email ?? "", state: l.state ?? "",
    },
  };
}

/**
 * A recruiter's corrections to the profile. Saved as the recruiter's value next to what the
 * driver told Crystal (which is kept); an emptied field clears the recruiter's value.
 * Returns the labels of the fields that changed.
 */
export async function saveProfileEdits(user: Viewer & { name: string }, id: string, values: Record<string, unknown>): Promise<string[] | null> {
  const l = await db.lead.findFirst({ where: { id, ...leadScope(user) }, include: { screening: true } });
  if (!l) return null;
  const str = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 1000) : null);
  const changed: string[] = [];
  const lead: Record<string, string | null> = {};
  for (const f of BASIC_FIELDS) {
    const v = str(values[f.key]);
    if (v === null || v === (l[f.key] ?? "")) continue;
    lead[f.key] = v || null;
    changed.push(f.label);
  }
  if (Object.keys(lead).length) await db.lead.update({ where: { id }, data: lead });
  const now = new Date();
  for (const f of PROFILE_FIELDS) {
    const v = str(values[f.key]);
    if (v === null) continue;
    const row = l.screening.find((x) => x.key === f.key);
    const current = (row?.verifiedValue || row?.reportedValue || (f.key === "accident_details" ? l.screening.find((x) => x.key === "accidents_at_fault")?.reportedValue : "") || "").trim();
    const shown = f.key === "recent_companies" ? splitEmployers(current).join("\n") : current;
    const lines = v.split(/\s*\n\s*/).map((x) => x.trim()).filter(Boolean);
    if ((f.key === "recent_companies" ? lines.join("\n") : v) === shown) continue;
    const value = f.key === "recent_companies" ? lines.join("\n") : v;
    await db.screeningField.upsert({
      where: { leadId_key: { leadId: id, key: f.key } },
      create: { leadId: id, key: f.key, verifiedValue: value || null, verifiedById: user.id, verifiedAt: now, status: "CORRECTED" },
      update: { verifiedValue: value || null, verifiedById: value ? user.id : null, verifiedAt: value ? now : null },
    });
    changed.push(f.label.replace(/ \(.*\)$/, ""));
  }
  if (changed.length) await recordEvent({ leadId: id, actorType: "USER", actorId: user.id, type: "PROFILE_EDITED", message: `Profile edited by ${user.name}: ${changed.join(", ")}` });
  return changed;
}
