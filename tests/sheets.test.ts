// Google Sheets connector: reviewed first import, ID-based dedupe on later
// syncs, status write-back, and the live HTTP contract (no network used).
import { generateKeyPairSync, createVerify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { drain, resetDb, seedBase } from "./helpers";
import { commitBatch, previewBatch } from "@/lib/import";
import { createSheetPreview, pollGoogleSheet, scheduleSheetPoll } from "@/lib/sheets-sync";
import { advancePipeline, optOutLead } from "@/lib/leads";
import { addDemoSheetRow, readDemoSheet, resetDemoSheet } from "@/adapters/mock";
import { GoogleSheetsSource, matchRows, buildAssertion, parseRange, indexToCol, colToIndex, resetGoogleTokenCache } from "@/adapters/live/google-sheets";

beforeEach(async () => { await resetDb(); await resetDemoSheet(); });

async function firstImport() {
  const base = await seedBase();
  const b = await createSheetPreview(base.admin, base.campaign.id);
  return { base, b };
}

describe("Google Sheets sync (demo sheet)", () => {
  it("first import is previewed; rows without an ID fall back to phone identity; mapping is saved", async () => {
    const { base, b } = await firstImport();
    const { preview } = await previewBatch(b.id, base.org.id);
    expect(preview.map((r) => r.disposition)).toEqual(["new", "new", "new"]);
    expect(preview[2].sourceRecordId).toBe("phone:+16025550143");
    expect(await db.lead.count()).toBe(0); // nothing saved before confirm
    const counts = await commitBatch(b.id, base.admin);
    expect(counts.created).toBe(3);
    const conn = await db.sourceConnection.findUniqueOrThrow({ where: { id: "google-sheets" } });
    expect((conn.mapping as Record<string, string>).sourceRecordId).toBe("Lead ID");
    const rec = await db.leadSourceRecord.findFirstOrThrow({ where: { sourceRecordId: "GS-1001" } });
    expect(rec.sourceSystem).toBe("GOOGLE_SHEETS");
  });

  it("later syncs import only new IDs and never duplicate, even after re-sorting", async () => {
    const { base, b } = await firstImport();
    await commitBatch(b.id, base.admin);
    expect((await pollGoogleSheet()).skipped).toMatch(/off/); // auto sync off by default
    const again = await pollGoogleSheet({ manual: true });
    expect(again.imported).toBeNull();
    expect(again.rowsWithErrors).toBe(0);
    // Re-sort the sheet and add a row: only the new ID is imported.
    const id = await addDemoSheetRow();
    const fs = await import("node:fs/promises"); const path = await import("node:path");
    const file = path.resolve(process.env.STORAGE_DIR!, "demo-sheet", "sheet.json");
    const s = JSON.parse(await fs.readFile(file, "utf8")); s.rows.reverse(); await fs.writeFile(file, JSON.stringify(s));
    const r = await pollGoogleSheet({ manual: true });
    expect(r.imported).toMatchObject({ created: 1 });
    expect(await db.leadSourceRecord.count({ where: { sourceRecordId: id } })).toBe(1);
    expect(await db.lead.count()).toBe(4);
    // Concurrent syncs do not double-import.
    await addDemoSheetRow();
    await Promise.all([pollGoogleSheet({ manual: true }), pollGoogleSheet({ manual: true })]);
    expect(await db.lead.count()).toBe(5);
    expect(await db.job.count({ where: { type: "lead.attempt-call", status: "PENDING" } })).toBe(5);
  });

  it("worker schedules at most one poll per interval when automatic sync is on", async () => {
    const { base, b } = await firstImport();
    await commitBatch(b.id, base.admin);
    await scheduleSheetPoll(0);
    expect(await db.job.count({ where: { type: "source.google-sheets.poll" } })).toBe(0);
    await db.sourceConnection.update({ where: { id: "google-sheets" }, data: { autoSync: true, pollMinutes: 5 } });
    const t = Date.now();
    await scheduleSheetPoll(t); await scheduleSheetPoll(t + 1000);
    expect(await db.job.count({ where: { type: "source.google-sheets.poll" } })).toBe(1);
    await addDemoSheetRow();
    await drain();
    expect(await db.leadSourceRecord.count({ where: { sourceSystem: "GOOGLE_SHEETS" } })).toBe(4);
  });

  it("writes progress back to the sheet without ever saying hired", async () => {
    const { base, b } = await firstImport();
    await commitBatch(b.id, base.admin);
    const rec = await db.leadSourceRecord.findFirstOrThrow({ where: { sourceRecordId: "GS-1001" } });
    await advancePipeline(rec.leadId, "HANDED_OFF");
    const other = await db.leadSourceRecord.findFirstOrThrow({ where: { sourceRecordId: "GS-1002" } });
    await optOutLead(other.leadId, "test", { type: "SYSTEM" });
    const noId = await db.leadSourceRecord.findFirstOrThrow({ where: { sourceRecordId: "phone:+16025550143" } });
    await advancePipeline(noId.leadId, "INTERESTED");
    await db.job.updateMany({ where: { type: { not: "lead.sync-source" } }, data: { status: "CANCELED" } });
    await drain();
    const sheet = await readDemoSheet();
    const st = (id: string) => sheet.rows.find((r) => r[0] === id)![8];
    expect(st("GS-1001")).toBe("With recruiter (not hired)");
    expect(st("GS-1002")).toBe("Opted out - do not contact");
    expect(sheet.rows.find((r) => r[1] === "No-ID")![8]).toBe("Interested"); // matched by phone
    expect((await db.leadSourceRecord.findUniqueOrThrow({ where: { id: rec.id } })).syncStatus).toBe("SYNCED");
  });

  it("a missing ID column fails the sync with a clear message and imports nothing", async () => {
    const { base, b } = await firstImport();
    await commitBatch(b.id, base.admin);
    const fs = await import("node:fs/promises"); const path = await import("node:path");
    const file = path.resolve(process.env.STORAGE_DIR!, "demo-sheet", "sheet.json");
    const s = await readDemoSheet(); s.headers[0] = "Renamed"; await fs.writeFile(file, JSON.stringify(s));
    const r = await pollGoogleSheet({ manual: true });
    expect(r.error).toMatch(/no "Lead ID" column/);
    expect((await db.sourceConnection.findUniqueOrThrow({ where: { id: "google-sheets" } })).lastError).toMatch(/Lead ID/);
  });
});

describe("Google Sheets live adapter (HTTP contract, no network)", () => {
  const ENV = ["GOOGLE_SHEETS_SPREADSHEET_ID", "GOOGLE_SHEETS_RANGE", "GOOGLE_SHEETS_ID_COLUMN", "GOOGLE_SHEETS_STATUS_COLUMN", "GOOGLE_SERVICE_ACCOUNT_EMAIL", "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"];
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  afterEach(() => { for (const k of ENV) delete process.env[k]; vi.unstubAllGlobals(); resetGoogleTokenCache(); });

  it("refuses to make any request without credentials", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const src = new GoogleSheetsSource();
    expect(src.status().state).toBe("missing_credentials");
    await expect(src.readSheet()).rejects.toThrow(/not configured/);
    expect(f).not.toHaveBeenCalled();
  });

  it("signs a valid RS256 assertion, reads formatted values, and writes status as RAW to the right cell", async () => {
    Object.assign(process.env, {
      GOOGLE_SHEETS_SPREADSHEET_ID: "sheet123", GOOGLE_SHEETS_RANGE: "Driver Leads", GOOGLE_SHEETS_ID_COLUMN: "Lead ID", GOOGLE_SHEETS_STATUS_COLUMN: "AI status",
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "molly@proj.iam.gserviceaccount.com", GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey.replace(/\n/g, "\\n"),
    });
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      if (init.method === "PUT") return new Response("{}");
      return new Response(JSON.stringify({ range: "'Driver Leads'!A1:Z1000", values: [["Lead ID", "Phone", "AI status"], ["A-1", "(214) 555-0101"], ["A-2", "(214) 555-0102", 45]] }));
    }));
    const src = new GoogleSheetsSource();
    expect(src.status().state).toBe("configured");
    const snap = await src.readSheet();
    expect(snap.rows).toEqual([["A-1", "(214) 555-0101", ""], ["A-2", "(214) 555-0102", "45"]]);
    const tokenCall = calls[0];
    const form = new URLSearchParams(String(tokenCall.init.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, c, sig] = form.get("assertion")!.split(".");
    const v = createVerify("RSA-SHA256"); v.update(`${h}.${c}`);
    expect(v.verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
    const claims = JSON.parse(Buffer.from(c, "base64url").toString());
    expect(claims).toMatchObject({ iss: "molly@proj.iam.gserviceaccount.com", aud: "https://oauth2.googleapis.com/token", scope: "https://www.googleapis.com/auth/spreadsheets" });
    expect(claims.exp - claims.iat).toBe(3600);
    expect(calls[1].url).toBe("https://sheets.googleapis.com/v4/spreadsheets/sheet123/values/Driver%20Leads?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE");
    expect((calls[1].init.headers as Record<string, string>).authorization).toBe("Bearer tok");

    expect(await src.writeStatus("A-2", "Interested")).toBe("written");
    const put = calls.find((x) => x.init.method === "PUT")!;
    expect(decodeURIComponent(put.url)).toContain("/values/'Driver Leads'!C3?valueInputOption=RAW");
    expect(JSON.parse(String(put.init.body)).values).toEqual([["Interested"]]);
    expect(await src.writeStatus("missing", "x")).toBe("row_not_found");
    expect(calls.filter((x) => x.url.includes("oauth2")).length).toBe(1); // token cached
  });

  it("uses the read-only scope when write-back is off", () => {
    const a = buildAssertion("x@y", privateKey, "https://www.googleapis.com/auth/spreadsheets.readonly", 1000);
    expect(JSON.parse(Buffer.from(a.split(".")[1], "base64url").toString()).scope).toMatch(/readonly$/);
  });

  it("parses ranges and column letters", () => {
    expect(parseRange("Leads!B5:Z")).toEqual({ sheet: "Leads", startCol: 1, startRow: 5 });
    expect(parseRange("Sheet1")).toEqual({ sheet: "Sheet1", startCol: 0, startRow: 1 });
    expect(indexToCol(0)).toBe("A"); expect(indexToCol(26)).toBe("AA"); expect(colToIndex("AB")).toBe(27);
  });

  it("finds rows by ID, or by phone for rows imported without an ID", () => {
    const rows = [["A-1", "(214) 555-0101"], ["", "214.555.0102"], ["A-1", "x"]];
    expect(matchRows(rows, 0, 1, "A-1")).toEqual([0, 2]);
    expect(matchRows(rows, 0, 1, "phone:+12145550102")).toEqual([1]);
    expect(matchRows(rows, 0, -1, "phone:+12145550102")).toEqual([]);
  });
});

