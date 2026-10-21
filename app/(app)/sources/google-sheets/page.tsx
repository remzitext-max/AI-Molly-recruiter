import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { config } from "@/lib/config";
import { recordEvent } from "@/lib/activity";
import { createSheetPreview, getSheetConnection, pollGoogleSheet, SHEETS_CONN_ID } from "@/lib/sheets-sync";
import { getAdapters } from "@/adapters/registry";
import { addDemoSheetRow, readDemoSheet } from "@/adapters/mock";
import { Badge, Card, fmt } from "@/components/ui";

const describe = (c: Record<string, number> | null | undefined) =>
  !c ? "no new rows" : `${c.created ?? 0} new lead(s), ${c.merged ?? 0} merged into existing leads`;

const back = (msg: string, kind: "ok" | "error" = "ok") => redirect(`/sources/google-sheets?${kind}=${encodeURIComponent(msg)}`);

async function preview(fd: FormData) {
  "use server";
  const u = await requireAdmin();
  let id: string;
  try { id = (await createSheetPreview(u, String(fd.get("campaignId")))).id; }
  catch (e) { back((e as Error).message, "error"); }
  redirect(`/import/${id!}`);
}

async function saveAuto(fd: FormData) {
  "use server";
  const u = await requireAdmin();
  const autoSync = fd.get("autoSync") === "on";
  const pollMinutes = Math.min(Math.max(Number(fd.get("pollMinutes")) || 5, 1), 60);
  const r = await db.sourceConnection.updateMany({ where: { id: SHEETS_CONN_ID, orgId: u.orgId }, data: { autoSync, pollMinutes } });
  if (!r.count) back("Preview and import the sheet once before turning on automatic sync.", "error");
  await recordEvent({ actorType: "USER", actorId: u.id, orgId: u.orgId, type: "SOURCE_SETTINGS", message: `Google Sheets automatic sync ${autoSync ? `on, every ${pollMinutes} min` : "off"}` });
  back(autoSync ? `Automatic sync is on (every ${pollMinutes} minutes).` : "Automatic sync is off.");
}

async function syncNow() {
  "use server";
  await requireAdmin();
  const r = await pollGoogleSheet({ manual: true });
  back(r.error ?? r.skipped ?? `Checked ${r.checkedRows} rows: ${describe(r.imported)}.${r.rowsWithErrors ? ` ${r.rowsWithErrors} row(s) need fixing in the sheet.` : ""}`, r.error || r.skipped ? "error" : "ok");
}

async function addDemoRow() {
  "use server";
  await requireAdmin();
  if (config.mode !== "demo") back("Only available in demo mode.", "error");
  const id = await addDemoSheetRow();
  back(`Added synthetic row ${id} to the demo sheet. It is imported on the next sync.`);
}

export default async function GoogleSheetsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const u = await requireAdmin();
  const sp = await searchParams;
  const src = getAdapters().sheets;
  const st = src.status();
  const [conn, campaigns] = await Promise.all([getSheetConnection(), db.campaign.findMany({ where: { orgId: u.orgId } })]);
  const demoSheet = src.isMock ? await readDemoSheet() : null;
  const summary = conn?.lastSummary as { checkedRows?: number; imported?: Record<string, number> | null; rowsWithErrors?: number } | null;
  const ready = st.state === "configured" || st.state === "mock";
  return (
    <>
      <h1>Google Sheets sync</h1>
      {sp.ok && <div className="alert ok">{sp.ok}</div>}
      {sp.error && <div className="alert error">{sp.error}</div>}
      <Card title="Connection" right={<Badge v={st.state} tone={st.state === "configured" ? "ok" : st.state === "mock" ? "demo" : "bad"} />}>
        <p>{st.detail}</p>
        <p className="small muted">Rows are matched by the <strong>{src.idColumn ?? "(not set)"}</strong> column, (or by phone number when the ID is empty), so re-sorting or editing the sheet never calls a driver twice. Edits to rows that were already imported are not copied over; change those leads in this app.
          {src.statusColumn ? <> Progress is written to the <strong>{src.statusColumn}</strong> column (it never says &ldquo;hired&rdquo;).</> : " Progress write-back is off."}</p>
        {!ready && <p className="small">Setup steps are in docs/INTEGRATIONS.md (Google Sheets section).</p>}
      </Card>

      <Card title="1. Review and import">
        <form action={preview}>
          <label>Campaign for these leads</label>
          <select name="campaignId" defaultValue={conn?.campaignId ?? undefined}>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}{c.isDemo ? " (demo)" : ""}</option>)}</select>
          <p className="small muted">Reads the sheet and opens the import preview. Nothing is saved until you confirm there. Confirming saves the column mapping for automatic syncs.</p>
          <button disabled={!ready}>Read sheet and preview</button>
        </form>
      </Card>

      <Card title="2. Automatic sync">
        {!conn ? <p className="muted">Available after the first reviewed import.</p> : (
          <>
            <form action={saveAuto} className="row">
              <label><input type="checkbox" name="autoSync" defaultChecked={conn.autoSync} /> Import new rows automatically every</label>
              <input type="number" name="pollMinutes" min={1} max={60} defaultValue={conn.pollMinutes} style={{ width: 70 }} /> minutes
              <button className="secondary">Save</button>
            </form>
            <form action={syncNow} style={{ marginTop: 8 }}><button className="secondary" disabled={!ready}>Sync now</button></form>
            <p className="small">Last sync: {fmt(conn.lastSyncAt)}{summary?.checkedRows !== undefined && <> · {summary.checkedRows} rows checked · {describe(summary.imported)}{summary.rowsWithErrors ? ` · ${summary.rowsWithErrors} row(s) need fixing in the sheet (use Read sheet and preview to see which)` : ""}</>}</p>
            {conn.lastError && <div className="alert error">Last sync failed: {conn.lastError}</div>}
            <p className="small muted">New leads are only called when contact rules allow it (permission, hours, pauses). Automatic sync runs in the background worker.</p>
          </>
        )}
      </Card>

      {demoSheet && (
        <Card title="Demo sheet (synthetic)" right={<form action={addDemoRow}><button className="secondary">Add a synthetic row</button></form>}>
          <table><thead><tr>{demoSheet.headers.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{demoSheet.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="small">{c || <span className="muted">—</span>}</td>)}</tr>)}</tbody></table>
          <p className="small muted">This local file stands in for a Google Sheet in demo mode. <Link href="/leads">See leads</Link></p>
        </Card>
      )}
    </>
  );
}
