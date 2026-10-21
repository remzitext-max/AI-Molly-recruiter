// CSV/XLSX lead import with mapping preview, validation and duplicate checks.
// Spreadsheet formulas are never evaluated and macros are never loaded:
// .xlsm/.xls are rejected and formula cells contribute only their cached text.
import Papa from "papaparse";
import ExcelJS from "exceljs";
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { sha256 } from "./crypto";
import { normalizePhone } from "./phone";
import { ingestLead } from "./leads";
import { recordEvent } from "./activity";

export const TARGET_FIELDS = [
  "sourceRecordId", "firstName", "lastName", "fullName", "phone", "email", "state", "zip",
  "callPermissionSource", "callPermissionDate", "smsPermissionSource", "smsPermissionDate",
] as const;
export type TargetField = (typeof TARGET_FIELDS)[number];
export type Mapping = Partial<Record<TargetField, string>>; // target -> source column header

/** Source system name for rows from the Google Sheets connector. */
export const SHEETS_SOURCE = "GOOGLE_SHEETS";

export interface ParsedSheet { headers: string[]; rows: string[][]; warnings: string[] }

const MAX_ROWS = 5000;

function cellToString(v: ExcelJS.CellValue, warnings: Set<string>): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    if ("formula" in v || "sharedFormula" in v) {
      warnings.add("Formula cells were not evaluated; their saved values were used as plain text.");
      const r = (v as { result?: unknown }).result;
      if (r === undefined || r === null || typeof r === "object") return "";
      return String(r);
    }
    if ("richText" in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join("");
    if ("text" in v) return String((v as { text: unknown }).text ?? "");
    if ("error" in v) return "";
  }
  return "";
}

export async function parseLeadFile(fileName: string, data: Buffer): Promise<ParsedSheet> {
  const lower = fileName.toLowerCase();
  const warnings = new Set<string>();
  let table: string[][];
  if (lower.endsWith(".csv")) {
    const text = data.toString("utf8").replace(/^﻿/, "");
    const r = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
    if (r.errors.length) warnings.add(`CSV parser: ${r.errors.slice(0, 3).map((e) => e.message).join("; ")}`);
    table = r.data.map((row) => row.map((c) => String(c ?? "")));
  } else if (lower.endsWith(".xlsx")) {
    // Reject macro-enabled workbooks disguised with a .xlsx name.
    if (data.includes(Buffer.from("vbaProject.bin"))) throw new Error("Macro-enabled workbooks are not accepted. Save as plain .xlsx or .csv.");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(data as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error("Workbook has no sheets");
    if (wb.worksheets.length > 1) warnings.add(`Only the first sheet ("${ws.name}") was read.`);
    table = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals: string[] = [];
      for (let c = 1; c <= ws.columnCount; c++) vals.push(cellToString(row.getCell(c).value, warnings));
      table.push(vals);
    });
  } else {
    throw new Error("Only .csv and .xlsx files are accepted.");
  }
  if (!table.length) throw new Error("File is empty");
  const headers = table[0].map((h, i) => h.trim() || `Column ${i + 1}`);
  const rows = table.slice(1).filter((r) => r.some((c) => c.trim()));
  if (rows.length > MAX_ROWS) throw new Error(`Too many rows (${rows.length}); split into files of ${MAX_ROWS} or fewer.`);
  return { headers, rows: rows.map((r) => headers.map((_, i) => (r[i] ?? "").trim())), warnings: [...warnings] };
}

const GUESS: Record<TargetField, RegExp> = {
  sourceRecordId: /^(lead ?id|id|record ?id|applicant ?id|source ?id|uuid)$/i,
  firstName: /^(first|first ?name|fname|given ?name)$/i,
  lastName: /^(last|last ?name|lname|surname|family ?name)$/i,
  fullName: /^(name|full ?name|driver ?name|driver)$/i,
  phone: /(phone|mobile|cell|tel)/i,
  email: /e-?mail/i,
  state: /^(state|st|home ?state)$/i,
  zip: /(zip|postal)/i,
  callPermissionSource: /(call|contact) ?(consent|permission) ?(source)?$/i,
  callPermissionDate: /(call|contact) ?(consent|permission) ?(date|time|timestamp)/i,
  smsPermissionSource: /(sms|text) ?(consent|permission) ?(source)?$/i,
  smsPermissionDate: /(sms|text) ?(consent|permission) ?(date|time|timestamp)/i,
};

// Optional Facebook lead-ad columns (e.g. added by Make.com). Read by header name,
// outside the reviewed mapping, so adding them to a sheet needs no re-setup.
const FB_COLUMNS = {
  fbLeadId: /^((fb|facebook) ?lead ?id|leadgen ?id)$/i,
  fbCampaign: /^((fb|facebook) )?campaign( name)?$/i,
  fbAd: /^((fb|facebook) )?ad( name)?$/i,
  fbForm: /^((fb|facebook) )?form( name)?$/i,
};

export function guessMapping(headers: string[]): Mapping {
  const m: Mapping = {};
  for (const f of TARGET_FIELDS) {
    const h = headers.find((x) => GUESS[f].test(x.trim()) && !Object.values(m).includes(x));
    if (h) m[f] = h;
  }
  return m;
}

export interface PreviewRow {
  rowNumber: number;
  values: Record<string, string>;
  phoneE164: string | null;
  sourceRecordId: string;
  errors: string[];
  warnings: string[];
  disposition: "new" | "merge_existing_phone" | "duplicate_source" | "duplicate_in_file" | "suppressed" | "error";
}

export async function buildPreview(sheet: ParsedSheet, mapping: Mapping, sourceSystem: string, orgId: string): Promise<PreviewRow[]> {
  const col = (row: string[], f: TargetField) => (mapping[f] ? row[sheet.headers.indexOf(mapping[f]!)] ?? "" : "").trim();
  const fbIdx = Object.fromEntries(Object.entries(FB_COLUMNS).map(([k, re]) => [k, sheet.headers.findIndex((h) => re.test(h.trim()))]));
  const fbCol = (row: string[], k: keyof typeof FB_COLUMNS) => (fbIdx[k] >= 0 ? row[fbIdx[k]] ?? "" : "").trim();
  const seenPhones = new Map<string, number>();
  const seenIds = new Set<string>();
  const out: PreviewRow[] = [];
  for (let i = 0; i < sheet.rows.length; i++) {
    const r = sheet.rows[i];
    const errors: string[] = [];
    const warnings: string[] = [];
    const phone = normalizePhone(col(r, "phone"));
    if (!mapping.phone) errors.push("No phone column mapped");
    else if (!phone) errors.push(`Invalid phone "${col(r, "phone")}"`);
    let first = col(r, "firstName"), last = col(r, "lastName");
    if (!first && !last && col(r, "fullName")) { const parts = col(r, "fullName").split(/\s+/); first = parts[0]; last = parts.slice(1).join(" "); }
    const state = col(r, "state").toUpperCase();
    if (state && !/^[A-Z]{2}$/.test(state)) warnings.push(`State "${state}" is not a 2-letter code`);
    const zip = col(r, "zip");
    if (zip && !/^\d{5}(-\d{4})?$/.test(zip)) warnings.push(`ZIP "${zip}" looks invalid`);
    const email = col(r, "email");
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) warnings.push("Email looks invalid");
    for (const [src, dt] of [["callPermissionSource", "callPermissionDate"], ["smsPermissionSource", "smsPermissionDate"]] as const) {
      if (col(r, src) && (!col(r, dt) || isNaN(new Date(col(r, dt)).getTime()))) warnings.push(`${src === "callPermissionSource" ? "Call" : "SMS"} permission has no valid date; it will be ignored`);
    }
    if (!col(r, "callPermissionSource")) warnings.push("No AI-call permission recorded; lead will wait for permission");
    // Stable identity: the source's own ID, else the normalized phone (never the row number).
    const sid = col(r, "sourceRecordId") || (phone ? `phone:${phone}` : `row-invalid-${i}`);
    let disposition: PreviewRow["disposition"] = errors.length ? "error" : "new";
    if (!errors.length && phone) {
      if (seenIds.has(sid) || seenPhones.has(phone)) disposition = "duplicate_in_file";
      else if (await db.leadSourceRecord.findUnique({ where: { sourceSystem_sourceRecordId: { sourceSystem, sourceRecordId: sid } } })) disposition = "duplicate_source";
      else if (await db.suppression.findUnique({ where: { phoneE164: phone } })) disposition = "suppressed";
      else if (await db.lead.findUnique({ where: { orgId_phoneE164: { orgId, phoneE164: phone } } })) disposition = "merge_existing_phone";
      seenIds.add(sid);
      seenPhones.set(phone, i);
    }
    const values: Record<string, string> = { firstName: first, lastName: last, phone: col(r, "phone"), email, state, zip,
      callPermissionSource: col(r, "callPermissionSource"), callPermissionDate: col(r, "callPermissionDate"),
      smsPermissionSource: col(r, "smsPermissionSource"), smsPermissionDate: col(r, "smsPermissionDate"),
      fbLeadId: fbCol(r, "fbLeadId"), fbCampaign: fbCol(r, "fbCampaign"), fbAd: fbCol(r, "fbAd"), fbForm: fbCol(r, "fbForm") };
    out.push({ rowNumber: i + 2, values, phoneE164: phone, sourceRecordId: sid, errors, warnings, disposition });
  }
  return out;
}

export async function createImportPreview(opts: { fileName: string; data: Buffer; campaignId: string; userId: string; orgId: string; isDemo: boolean; mapping?: Mapping }) {
  const sheet = await parseLeadFile(opts.fileName, opts.data);
  const mapping = opts.mapping ?? guessMapping(sheet.headers);
  const sourceSystem = opts.fileName.toLowerCase().endsWith(".csv") ? "CSV" : "XLSX";
  const fileSha = sha256(opts.data);
  const prior = await db.importBatch.findFirst({ where: { fileSha256: fileSha, status: "COMMITTED" } });
  const batch = await db.importBatch.create({
    data: {
      fileName: opts.fileName.slice(0, 200), fileSha256: fileSha, sourceSystem, mapping: mapping as Prisma.InputJsonValue,
      rows: { headers: sheet.headers, rows: sheet.rows, warnings: prior ? [...sheet.warnings, `This exact file was already imported on ${prior.committedAt?.toISOString().slice(0, 10)}. Duplicates will be skipped.`] : sheet.warnings } as Prisma.InputJsonValue,
      campaignId: opts.campaignId, isDemo: opts.isDemo, createdById: opts.userId,
    },
  });
  return batch;
}

export async function previewBatch(batchId: string, orgId: string) {
  const b = await db.importBatch.findUniqueOrThrow({ where: { id: batchId } });
  const stored = b.rows as unknown as ParsedSheet;
  const preview = await buildPreview(stored, b.mapping as Mapping, b.sourceSystem, orgId);
  return { batch: b, headers: stored.headers, warnings: stored.warnings, preview };
}

/** Commit a previewed batch. `user.id` is null when the system commits (scheduled Google Sheets sync). */
export async function commitBatch(batchId: string, user: { id: string | null; orgId: string }) {
  const b = await db.importBatch.findUniqueOrThrow({ where: { id: batchId } });
  if (b.status !== "PREVIEW") throw new Error("This import was already committed or discarded");
  const claimed = await db.importBatch.updateMany({ where: { id: batchId, status: "PREVIEW" }, data: { status: "COMMITTING" } });
  if (!claimed.count) throw new Error("This import is already being committed");
  const { preview } = await previewBatch(batchId, user.orgId);
  const counts: Record<string, number> = { created: 0, merged: 0, duplicate_source: 0, skipped_errors: 0, skipped_in_file_duplicates: 0 };
  for (const row of preview) {
    if (row.disposition === "error") { counts.skipped_errors++; continue; }
    if (row.disposition === "duplicate_in_file") { counts.skipped_in_file_duplicates++; continue; }
    const v = row.values;
    const permission: { scope: "AI_CALL" | "SMS"; source: string; grantedAt: string }[] = [];
    if (v.callPermissionSource && v.callPermissionDate && !isNaN(new Date(v.callPermissionDate).getTime())) permission.push({ scope: "AI_CALL", source: v.callPermissionSource, grantedAt: new Date(v.callPermissionDate).toISOString() });
    if (v.smsPermissionSource && v.smsPermissionDate && !isNaN(new Date(v.smsPermissionDate).getTime())) permission.push({ scope: "SMS", source: v.smsPermissionSource, grantedAt: new Date(v.smsPermissionDate).toISOString() });
    const r = await ingestLead(
      { sourceSystem: b.sourceSystem, sourceRecordId: row.sourceRecordId, firstName: v.firstName, lastName: v.lastName, phone: v.phone, email: v.email, state: v.state, zip: v.zip, permission,
        fb: { leadId: v.fbLeadId, campaign: v.fbCampaign, ad: v.fbAd, form: v.fbForm }, raw: { row: row.rowNumber, file: b.fileName } },
      { orgId: user.orgId, campaignId: b.campaignId, isDemo: b.isDemo, importBatchId: b.id, actorId: user.id },
    );
    if (r.result === "invalid") counts.skipped_errors++; else counts[r.result]++;
  }
  await db.importBatch.update({ where: { id: batchId }, data: { status: "COMMITTED", committedAt: new Date(), summary: counts } });
  await recordEvent({ actorType: user.id ? "USER" : "SYSTEM", actorId: user.id, orgId: user.orgId, type: "IMPORT", message: `Imported ${b.fileName}: ${JSON.stringify(counts)}` });
  // An admin-reviewed Google Sheets import saves its mapping and campaign for later automatic syncs.
  if (b.sourceSystem === SHEETS_SOURCE && user.id) {
    const data = { orgId: user.orgId, campaignId: b.campaignId, mapping: b.mapping as Prisma.InputJsonValue };
    await db.sourceConnection.upsert({ where: { id: "google-sheets" }, create: { id: "google-sheets", ...data }, update: data });
  }
  return counts;
}
