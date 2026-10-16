// Technical quality check for a voice-clone source recording. Runs locally;
// the recording is not sent to any provider by this step.
export interface AudioReport {
  format: string; ok: boolean; sampleRate?: number; channels?: number; bitsPerSample?: number; durationSec?: number;
  peakDbfs?: number; rmsDbfs?: number; clippedPct?: number; silencePct?: number; issues: string[]; notes: string[];
}

export function inspectAudio(buf: Buffer, fileName: string): AudioReport {
  const issues: string[] = [];
  const notes: string[] = [];
  if (buf.subarray(0, 4).toString("latin1") !== "RIFF" || buf.subarray(8, 12).toString("latin1") !== "WAVE") {
    const ext = fileName.split(".").pop()?.toLowerCase();
    return { format: ext ?? "unknown", ok: false, issues: ["Detailed analysis supports uncompressed WAV only. Export the original recording as 16-bit WAV (44.1 or 48 kHz) and inspect again."], notes: [`File size ${(buf.length / 1048576).toFixed(1)} MB`] };
  }
  let off = 12; let fmt: { ch: number; rate: number; bits: number; audioFormat: number } | null = null; let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.subarray(off, off + 4).toString("latin1"); const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { audioFormat: buf.readUInt16LE(off + 8), ch: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === "data") data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) return { format: "wav", ok: false, issues: ["WAV file is missing fmt or data chunk"], notes };
  if (fmt.audioFormat !== 1 || fmt.bits !== 16) return { format: "wav", ok: false, sampleRate: fmt.rate, channels: fmt.ch, bitsPerSample: fmt.bits, issues: ["Only 16-bit PCM WAV can be analysed here"], notes };
  const frames = Math.floor(data.length / (2 * fmt.ch));
  const dur = frames / fmt.rate;
  let peak = 0, sumSq = 0, clipped = 0, silentWin = 0, wins = 0, winSum = 0, winN = 0;
  const winSize = Math.floor(fmt.rate * 0.05);
  for (let i = 0; i < frames; i++) {
    let v = 0;
    for (let c = 0; c < fmt.ch; c++) v += data.readInt16LE((i * fmt.ch + c) * 2);
    v = v / fmt.ch / 32768;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
    sumSq += v * v; winSum += v * v; winN++;
    if (winN === winSize) { wins++; if (Math.sqrt(winSum / winN) < 0.003) silentWin++; winSum = 0; winN = 0; }
  }
  const db = (x: number) => (x > 0 ? Math.round(20 * Math.log10(x) * 10) / 10 : -120);
  const rms = Math.sqrt(sumSq / Math.max(1, frames));
  const r: AudioReport = {
    format: "wav", ok: true, sampleRate: fmt.rate, channels: fmt.ch, bitsPerSample: fmt.bits, durationSec: Math.round(dur * 10) / 10,
    peakDbfs: db(peak), rmsDbfs: db(rms), clippedPct: Math.round((clipped / Math.max(1, frames)) * 10000) / 100,
    silencePct: wins ? Math.round((silentWin / wins) * 1000) / 10 : 0, issues, notes,
  };
  if (fmt.rate < 22050) issues.push(`Sample rate ${fmt.rate} Hz is low; 44.1 kHz or 48 kHz is recommended.`);
  if (dur < 60) issues.push(`Only ${Math.round(dur)} s of audio. Instant clones typically need 1-3 minutes; professional clones 30+ minutes (check the chosen provider).`);
  if (r.clippedPct! > 0.1) issues.push(`${r.clippedPct}% of samples are clipped; re-record with lower input gain.`);
  if (r.peakDbfs! < -12) issues.push(`Recording is quiet (peak ${r.peakDbfs} dBFS); aim for peaks around -6 to -3 dBFS.`);
  if (r.silencePct! > 35) issues.push(`${r.silencePct}% of the file is near-silence; trim long pauses.`);
  notes.push("This check cannot confirm that only Molly is speaking or that there is no background noise: listen to the full file before use.");
  r.ok = issues.length === 0;
  return r;
}
