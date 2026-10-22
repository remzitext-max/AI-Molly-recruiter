// After a driver sends a CDL / medical card file: read it (vision model in live
// mode), keep the fields on the document for review, fill the matching screening
// answers the call did not get, and post a short summary to Telegram.
import { db } from "./db";
import { getAdapters } from "../adapters/registry";
import { recordEvent } from "./activity";
import { sendTelegram, telegramConfigured, recruiterTags } from "./telegram";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const words = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 1);

/** Whether the name on the document plausibly belongs to the lead (first or last name appears). Exported for tests. */
export function nameMatches(docName: string, lead: { firstName: string | null; lastName: string | null }): boolean | null {
  const ours = words(`${lead.firstName ?? ""} ${lead.lastName ?? ""}`);
  if (!ours.length || !docName.trim()) return null;
  const theirs = new Set(words(docName));
  return ours.some((w) => theirs.has(w));
}

export async function readDocument(documentId: string, now = new Date()) {
  const d = await db.document.findUnique({ where: { id: documentId }, include: { lead: { include: { screening: true } } } });
  if (!d || d.deletedAt) return { read: false };
  const data = await getAdapters().storage.get(d.storageKey);
  const ex = await getAdapters().extraction.extract(data, d.mimeType);
  const f = Object.fromEntries(ex.fields.filter((x) => x.value).map((x) => [x.name, x.value!]));
  const kind = /med/i.test(ex.docType ?? "") ? "MED_CARD" : /cdl/i.test(ex.docType ?? "") ? "CDL" : d.kind;
  const warnings = [...ex.warnings];
  const match = f.full_name ? nameMatches(f.full_name, d.lead) : null;
  if (match === false) warnings.unshift(`Name on the document (${f.full_name}) does not match the lead's name.`);
  const exp = f.expiration_date && /^\d{4}-\d{2}-\d{2}$/.test(f.expiration_date) ? new Date(`${f.expiration_date}T00:00:00Z`) : null;
  const days = exp ? Math.floor((exp.getTime() - now.getTime()) / 86400_000) : null;
  if (days !== null && days < 0) warnings.unshift(`${kind === "MED_CARD" ? "Medical card" : "CDL"} expired on ${f.expiration_date}.`);
  else if (days !== null && days < 60) warnings.unshift(`${kind === "MED_CARD" ? "Medical card" : "CDL"} expires in ${days} days (${f.expiration_date}).`);
  await db.document.update({ where: { id: d.id }, data: { kind, extraction: { fields: ex.fields, warnings, docType: ex.docType ?? null, nameMatches: match } as object } });
  if (!ex.fields.length) return { read: false };

  // Fill answers the call did not get; never overwrite what the driver said.
  const have = new Set(d.lead.screening.filter((s) => s.reportedValue).map((s) => s.key));
  const fill: [string, string | undefined][] = kind === "MED_CARD" ? [["med_card_expiry", f.expiration_date]] : [["cdl_class", f.license_class && `Class ${f.license_class.replace(/^class\s*/i, "")}`], ["endorsements", f.endorsements]];
  for (const [key, value] of fill) {
    if (!value || have.has(key)) continue;
    await db.screeningField.upsert({
      where: { leadId_key: { leadId: d.leadId, key } },
      create: { leadId: d.leadId, key, reportedValue: value, rawUtterance: `(read from ${kind === "MED_CARD" ? "medical card" : "CDL"} photo)`, status: "CAPTURED" },
      update: { reportedValue: value, rawUtterance: `(read from ${kind === "MED_CARD" ? "medical card" : "CDL"} photo)`, status: "CAPTURED" },
    });
  }
  await recordEvent({ leadId: d.leadId, actorType: "SYSTEM", type: "DOCUMENT_READ", message: `${kind === "MED_CARD" ? "Medical card" : kind === "CDL" ? "CDL" : "Document"} read: ${Object.keys(f).join(", ")}${warnings.length > 1 ? ` · ${warnings[0]}` : ""}`, data: { documentId: d.id } });

  if (telegramConfigured() && !d.lead.isDemo) {
    const name = [d.lead.firstName, d.lead.lastName].filter(Boolean).join(" ");
    const lines = [
      ...(await recruiterTags(d.leadId)),
      `🔎 Read from ${kind === "MED_CARD" ? "medical card" : "CDL"}: ${esc(name)}`,
      kind === "CDL" && f.license_class ? `🪪 Class ${esc(f.license_class)}${f.state ? `, ${esc(f.state)}` : ""}${f.endorsements ? `, endorsements ${esc(f.endorsements)}` : ""}` : null,
      f.expiration_date ? `📅 Expires ${esc(f.expiration_date)}` : null,
      match === true ? "✅ Name matches" : match === false ? `⚠️ Name on it: ${esc(f.full_name)}` : null,
      ...warnings.filter((w) => /expire/i.test(w)).map((w) => `⚠️ ${esc(w)}`),
      "(AI read, please check the photo)",
    ].filter(Boolean);
    await sendTelegram(lines.join("\n"), d.leadId);
  }
  return { read: true, fields: f };
}
