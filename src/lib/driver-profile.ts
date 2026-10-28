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
}

const TZ = "America/Chicago";
export const when = (d: Date | null | undefined) => (d ? DateTime.fromJSDate(d).setZone(TZ).toFormat("LLL d, h:mm a") : "");
const words = (s: string | null | undefined) => (s ?? "").replace(/_/g, " ").toLowerCase();

export function sourceLabel(s: string) {
  if (s === "GOOGLE_SHEETS") return "Google Sheet · Pool";
  if (s.startsWith("GOOGLE_SHEETS:")) {
    const gid = s.split(":")[1];
    const tab = config.googleSheets.extraTabs.find((t) => t.gid === gid);
    return `Google Sheet · ${tab ? tab.tag : `tab ${gid}`}`;
  }
  return s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");
}

/** "Swift 2023-now, Werner 2021-2023" -> one employer per line. */
export function splitEmployers(text: string | null | undefined): string[] {
  return (text ?? "").split(/\s*(?:;|\n|,(?=\s*[A-Za-z]))\s*/).map((s) => s.trim()).filter(Boolean);
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
  const val = (k: string) => (a(k) ? `${a(k)}${verified.has(k) ? " (verified)" : ""}` : "");
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
    status: words(l.pipelineStatus),
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
    ] as Row[]),
    employers: splitEmployers(a("recent_companies")),
    summary,
    calls: l.calls.map((c) => ({
      id: c.id,
      when: when(c.createdAt),
      length: c.startedAt && c.endedAt ? `${Math.round((c.endedAt.getTime() - c.startedAt.getTime()) / 1000)} sec` : "",
      result: [words(c.status), words(c.outcome)].filter(Boolean).join(" · "),
      endedBy: endedByText(whoEnded(c), config.agentPersona.name) ?? "",
      recording: !!c.recordingKey,
    })),
    documents: l.documents.map((d) => {
      const fields = ((d.extraction as { fields?: { name: string; value: string | null }[] } | null)?.fields ?? []).filter((f) => f.value);
      return { id: d.id, kind: d.kind === "MED_CARD" ? "Medical card" : "CDL", when: when(d.uploadedAt), read: fields.map((f) => `${words(f.name)} ${f.value}`).join(" · ") };
    }),
    timeline: l.events.map((e) => ({ when: when(e.createdAt), who: who(e), what: e.message })),
  };
}
