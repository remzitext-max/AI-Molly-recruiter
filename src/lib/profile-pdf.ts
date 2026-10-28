// Writes a driver profile (see driver-profile.ts) as a Letter-size PDF:
// header, profile and deal, employers, calls, documents, timeline.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { DateTime } from "luxon";
import type { DriverProfile, Row } from "./driver-profile";

const W = 612, H = 792, M = 42, BOTTOM = 54;
const INK = rgb(0.07, 0.09, 0.15), MUTED = rgb(0.42, 0.45, 0.5), LINE = rgb(0.88, 0.9, 0.93), FILL = rgb(0.95, 0.96, 0.98), ACCENT = rgb(0.15, 0.39, 0.92);

export const pdfFileName = (p: DriverProfile) => `${p.name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "") || "driver"}_profile_${DateTime.now().setZone("America/Chicago").toFormat("yyyy-LL-dd")}.pdf`;

export async function profilePdf(p: DriverProfile, generatedBy: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${p.name} - driver profile`);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  // The standard fonts cover Latin text only; anything else (emoji, other scripts) is dropped.
  const known = new Set(font.getCharacterSet());
  const clean = (s: string) => [...s.replace(/[\r\t]+/g, " ")].map((c) => (c === "\n" || known.has(c.codePointAt(0)!) ? c : c === "✓" ? "v" : "")).join("");

  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };
  const need = (h: number) => { if (y - h < BOTTOM) newPage(); };

  const wrap = (text: string, f: PDFFont, size: number, width: number): string[] => {
    const out: string[] = [];
    for (const para of clean(text).split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (f.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
        if (line) out.push(line);
        // A single word wider than the column is cut into pieces.
        let w = word;
        while (f.widthOfTextAtSize(w, size) > width && w.length > 1) {
          let n = w.length - 1;
          while (n > 1 && f.widthOfTextAtSize(w.slice(0, n), size) > width) n--;
          out.push(w.slice(0, n));
          w = w.slice(n);
        }
        line = w;
      }
      out.push(line);
    }
    return out.length ? out : [""];
  };
  const text = (s: string, x: number, yy: number, size = 9.5, f = font, color = INK) => page.drawText(clean(s), { x, y: yy, size, font: f, color });

  const heading = (s: string) => {
    need(34);
    y -= 14;
    text(s.toUpperCase(), M, y, 9, bold, MUTED);
    y -= 6;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.7, color: LINE });
    y -= 4;
  };

  /** A table: column widths in points, optional header, rows of cell strings. */
  const table = (widths: number[], rows: string[][], header?: string[], size = 9) => {
    const lh = size * 1.3;
    const draw = (cells: string[], f: PDFFont, shade: boolean) => {
      const lines = cells.map((c, i) => wrap(c || "-", f, size, widths[i] - 8));
      const h = Math.max(...lines.map((l) => l.length)) * lh + 6;
      need(h);
      if (shade) page.drawRectangle({ x: M, y: y - h, width: widths.reduce((a, b) => a + b, 0), height: h, color: FILL });
      let x = M;
      lines.forEach((ls, i) => {
        ls.forEach((l, j) => text(l, x + 4, y - 3 - size - j * lh + 1, size, f, cells[i] ? INK : MUTED));
        x += widths[i];
      });
      y -= h;
      page.drawLine({ start: { x: M, y }, end: { x: M + widths.reduce((a, b) => a + b, 0), y }, thickness: 0.5, color: LINE });
    };
    if (header) draw(header, bold, true);
    for (const r of rows) draw(r, font, false);
  };

  const pairs = (rows: Row[]) => rows.map(([k, v]) => [k, v]);
  const full = W - 2 * M;

  // Header
  text(p.name, M, y - 20, 22, bold);
  y -= 34;
  const meta = [p.phone, p.email, p.location, p.source].filter(Boolean).join("   ·   ");
  for (const l of wrap(meta, font, 10, full)) { text(l, M, y, 10, font, MUTED); y -= 13; }
  y -= 4;
  page.drawRectangle({ x: M, y: y - 26, width: full, height: 26, color: rgb(0.92, 0.95, 1) });
  const strip = `Status: ${p.hiring ?? p.status}     Recruiter: ${p.recruiter}     Applied: ${p.applied}`;
  text(strip, M + 8, y - 17, 9.5, bold, ACCENT);
  y -= 34;
  for (const l of wrap(`Fit: ${p.fit.text}`, font, 9, full)) { text(l, M, y, 9, font, MUTED); y -= 12; }

  heading("Driver profile and deal");
  const half = full / 2;
  const left = pairs(p.driver), right = pairs(p.deal);
  const merged: string[][] = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) merged.push([...(left[i] ?? ["", ""]), ...(right[i] ?? ["", ""])]);
  table([half * 0.42, half * 0.58, half * 0.42, half * 0.58], merged);

  if (p.summary) {
    heading("Call notes");
    for (const l of wrap(p.summary, font, 9.5, full)) { need(13); text(l, M, y - 10, 9.5); y -= 13; }
    y -= 4;
  }

  heading("Previous employers (last 3 years, from the driver)");
  if (p.employers.length) table([full], p.employers.map((e) => [e]));
  else { text("Not collected yet.", M, y - 11, 9, font, MUTED); y -= 16; }

  heading("Calls");
  if (p.calls.length) table([full * 0.22, full * 0.12, full * 0.28, full * 0.28, full * 0.1], p.calls.map((c) => [c.when, c.length, c.result, c.endedBy, c.recording ? "yes" : "no"]), ["When (Central)", "Length", "Result", "Ended by", "Recording"]);
  else { text("No calls yet.", M, y - 11, 9, font, MUTED); y -= 16; }

  heading("Documents");
  if (p.documents.length) table([full * 0.18, full * 0.2, full * 0.62], p.documents.map((d) => [d.kind, d.when, d.read ? `Read by AI: ${d.read}` : ""]), ["Document", "Received", "Details"]);
  else { text("No CDL or medical card yet.", M, y - 11, 9, font, MUTED); y -= 16; }

  heading("Timeline");
  table([full * 0.18, full * 0.16, full * 0.66], p.timeline.map((t) => [t.when, t.who, t.what]), ["When (Central)", "Who", "What"], 8.5);

  // Footer on every page
  const stamp = `${p.name} · driver profile · generated ${DateTime.now().setZone("America/Chicago").toFormat("LLL d, yyyy h:mm a")} (Central) by ${generatedBy}`;
  const pages = doc.getPages();
  pages.forEach((pg, i) => {
    pg.drawText(clean(stamp), { x: M, y: 28, size: 7.5, font, color: MUTED });
    const n = `${i + 1} / ${pages.length}`;
    pg.drawText(n, { x: W - M - font.widthOfTextAtSize(n, 7.5), y: 28, size: 7.5, font, color: MUTED });
  });
  return doc.save();
}
