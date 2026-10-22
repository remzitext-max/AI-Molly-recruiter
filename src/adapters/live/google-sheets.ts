// Google Sheets lead source (read rows, optional status write-back).
// Auth: a Google Cloud service account (OAuth 2.0 JWT bearer flow,
// https://developers.google.com/identity/protocols/oauth2/service-account).
// The spreadsheet must be shared with the service account's email.
// Reads use valueRenderOption=FORMATTED_VALUE (cell text as shown in Sheets);
// writes use valueInputOption=RAW so nothing the app writes is parsed as a formula.
import { createSign } from "node:crypto";
import { config } from "../../lib/config";
import { normalizePhone } from "../../lib/phone";
import { providerFetch } from "./http";
import { LiveContactBlockedError, type IntegrationStatus, type SheetLeadSource, type SheetSnapshot } from "../types";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://sheets.googleapis.com/v4/spreadsheets";

let tokenCache: { key: string; token: string; exp: number } | null = null;

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** Build the signed RS256 JWT assertion for the token request. Exported for tests. */
export function buildAssertion(email: string, privateKey: string, scope: string, nowSec = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: email, scope, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(privateKey))}`;
}

/** Column index (0-based) <-> A1 letters. */
export function colToIndex(letters: string) { return letters.toUpperCase().split("").reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1; }
export function indexToCol(i: number) { let s = ""; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; }

/** Split a returned range like "'Driver Leads'!A1:Z200" into sheet part and top-left cell. */
export function parseRange(range: string) {
  const bang = range.lastIndexOf("!");
  const sheet = bang >= 0 ? range.slice(0, bang) : range;
  const cell = bang >= 0 ? range.slice(bang + 1) : "";
  const m = /^([A-Za-z]+)?(\d+)?/.exec(cell.split(":")[0]) ?? [];
  return { sheet, startCol: m[1] ? colToIndex(m[1]) : 0, startRow: m[2] ? Number(m[2]) : 1 };
}

const quote = (title: string) => `'${title.replace(/'/g, "''")}'`;

/** A bare tab name with spaces or symbols ("📥 Pool") becomes a quoted A1 range; "A:Z", "Tab!A1:Z" and "Pool" pass through. Exported for tests. */
export function quoteTab(range: string) {
  if (range.includes("!") || /^'.*'$/.test(range) || /^[A-Za-z0-9:]+$/.test(range)) return range;
  return quote(range);
}

/** Row indexes matching a record: by ID, or by normalized phone for "phone:" identities. */
export function matchRows(rows: string[][], idIdx: number, phoneIdx: number, sourceRecordId: string): number[] {
  const byPhone = sourceRecordId.startsWith("phone:") ? sourceRecordId.slice(6) : null;
  if (byPhone && phoneIdx < 0) return [];
  return rows.map((r, i) => (byPhone ? normalizePhone(r[phoneIdx]) === byPhone : (r[idIdx] ?? "").trim() === sourceRecordId) ? i : -1).filter((i) => i >= 0);
}

export class GoogleSheetsSource implements SheetLeadSource {
  key = "google-sheets";
  isMock = false;
  get idColumn() { return config.googleSheets.idColumn; }
  get statusColumn() { return config.googleSheets.statusColumn; }

  private missing() {
    const g = config.googleSheets;
    return [
      !g.spreadsheetId && "GOOGLE_SHEETS_SPREADSHEET_ID", !g.idColumn && "GOOGLE_SHEETS_ID_COLUMN",
      !g.serviceAccountEmail && "GOOGLE_SERVICE_ACCOUNT_EMAIL", !g.privateKey && "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY",
    ].filter(Boolean) as string[];
  }

  status(): IntegrationStatus {
    const missing = this.missing();
    if (missing.length) return { kind: "lead_source", provider: "Google Sheets", isMock: false, state: "missing_credentials", detail: `Set ${missing.join(", ")}. Share the sheet with the service account email.` };
    return {
      kind: "lead_source", provider: "Google Sheets", isMock: false, state: "configured",
      detail: `Reads "${config.googleSheets.range}" with a service account; rows identified by the "${this.idColumn}" column.${this.statusColumn ? ` Writes progress to "${this.statusColumn}".` : " Status write-back is off."}`,
      capabilities: { read_rows: "unverified", write_status: this.statusColumn ? "unverified" : "blocked" },
    };
  }

  private async token(): Promise<string> {
    const missing = this.missing();
    if (missing.length) throw new LiveContactBlockedError(`Google Sheets is not configured (missing ${missing.join(", ")})`);
    const g = config.googleSheets;
    const scope = this.statusColumn ? "https://www.googleapis.com/auth/spreadsheets" : "https://www.googleapis.com/auth/spreadsheets.readonly";
    const key = `${g.serviceAccountEmail}|${scope}`;
    if (tokenCache && tokenCache.key === key && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
    const res = await providerFetch(TOKEN_URL, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: buildAssertion(g.serviceAccountEmail!, g.privateKey!, scope) }).toString(),
    });
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new Error("Google token response had no access_token");
    tokenCache = { key, token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return j.access_token;
  }

  /** GOOGLE_SHEETS_RANGE as A1 notation; "gid:<id>" picks the tab by the id in its URL, so emoji or renamed tabs still work. */
  private async range(r = config.googleSheets.range) {
    const g = config.googleSheets;
    const gid = /^gid[:=](\d+)$/i.exec(r.trim());
    if (!gid) return quoteTab(r);
    const url = `${API}/${encodeURIComponent(g.spreadsheetId!)}?fields=sheets.properties(sheetId,title)`;
    const res = await providerFetch(url, { headers: { authorization: `Bearer ${await this.token()}` } });
    const j = (await res.json()) as { sheets?: { properties: { sheetId: number; title: string } }[] };
    const title = j.sheets?.find((s) => String(s.properties.sheetId) === gid[1])?.properties.title;
    if (title === undefined) throw new Error(`The spreadsheet has no tab with gid ${gid[1]}`);
    return quote(title);
  }

  async listTabs(): Promise<string[]> {
    const url = `${API}/${encodeURIComponent(config.googleSheets.spreadsheetId!)}?fields=sheets.properties(title)`;
    const res = await providerFetch(url, { headers: { authorization: `Bearer ${await this.token()}` } });
    const j = (await res.json()) as { sheets?: { properties: { title: string } }[] };
    return (j.sheets ?? []).map((s) => s.properties.title);
  }

  private async getValues(r?: string) {
    const g = config.googleSheets;
    const url = `${API}/${encodeURIComponent(g.spreadsheetId!)}/values/${encodeURIComponent(await this.range(r))}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;
    const res = await providerFetch(url, { headers: { authorization: `Bearer ${await this.token()}` } });
    return (await res.json()) as { range: string; values?: unknown[][] };
  }

  async readSheet(r?: string): Promise<SheetSnapshot> {
    const v = await this.getValues(r);
    const values = (v.values ?? []).map((r) => r.map((c) => (c === null || c === undefined ? "" : String(c))));
    const headers = (values[0] ?? []).map((h) => h.trim());
    const rows = values.slice(1).map((r) => headers.map((_, i) => r[i] ?? ""));
    return { title: v.range, headers, rows, warnings: ["Values are read as shown in Google Sheets. Anything a formula calculated arrives as plain text; this app never runs formulas."] };
  }

  async writeStatus(sourceRecordId: string, text: string, phoneColumn?: string) {
    if (!this.statusColumn) return "not_enabled" as const;
    const v = await this.getValues();
    const values = v.values ?? [];
    const headers = (values[0] ?? []).map((h) => String(h ?? "").trim());
    const idIdx = headers.indexOf(this.idColumn ?? "");
    const stIdx = headers.indexOf(this.statusColumn);
    if (idIdx < 0 || stIdx < 0) throw new Error(`Sheet is missing the "${idIdx < 0 ? this.idColumn : this.statusColumn}" column`);
    const matches = matchRows(values.slice(1).map((r) => r.map((c) => String(c ?? ""))), idIdx, headers.indexOf(phoneColumn ?? ""), sourceRecordId);
    if (!matches.length) return "row_not_found" as const;
    if (matches.length > 1) return "ambiguous_id" as const;
    const { sheet, startCol, startRow } = parseRange(v.range);
    const cell = `${sheet}!${indexToCol(startCol + stIdx)}${startRow + 1 + matches[0]}`;
    const url = `${API}/${encodeURIComponent(config.googleSheets.spreadsheetId!)}/values/${encodeURIComponent(cell)}?valueInputOption=RAW`;
    await providerFetch(url, {
      method: "PUT", headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json" },
      body: JSON.stringify({ range: cell, majorDimension: "ROWS", values: [[text]] }),
    });
    return "written" as const;
  }
}

/** Test hook. */
export function resetGoogleTokenCache() { tokenCache = null; }
