// Durable background worker. Safe to run several instances and to restart at
// any time: jobs live in Postgres and abandoned locks are reclaimed.
import os from "node:os";
import { claimJobs, enqueue, runJob } from "../src/lib/jobs/queue";
import { handlers } from "../src/lib/jobs/handlers";
import { db } from "../src/lib/db";
import { config } from "../src/lib/config";
import { log } from "../src/lib/redact";
import { SHEET_FAST_POLL_MS, scheduleSheetPoll } from "../src/lib/sheets-sync";
import { scheduleInboundSmsPoll } from "../src/lib/messaging";
import { scheduleReengageScan } from "../src/lib/reengage";
import { scheduleMetaSync } from "../src/lib/meta";

const workerId = `${os.hostname()}:${process.pid}`;
let stopping = false;

async function scheduleMaintenance() {
  const day = new Date().toISOString().slice(0, 10);
  await enqueue("maintenance.retention", {}, { idempotencyKey: `retention:${day}` });
}

async function main() {
  log.info(`worker ${workerId} starting in ${config.mode.toUpperCase()} mode`);
  await scheduleMaintenance();
  let lastMaint = Date.now();
  let lastSheetCheck = 0;
  let lastFastSheetCheck = 0;
  while (!stopping) {
    try {
      const jobs = await claimJobs(workerId, 5);
      for (const j of jobs) await runJob(j, handlers);
      if (Date.now() - lastMaint > 60 * 60 * 1000) { await scheduleMaintenance(); lastMaint = Date.now(); }
      if (Date.now() - lastFastSheetCheck > SHEET_FAST_POLL_MS) { await scheduleSheetPoll(); lastFastSheetCheck = Date.now(); }
      if (Date.now() - lastSheetCheck > 60 * 1000) { await scheduleInboundSmsPoll(); await scheduleReengageScan(); await scheduleMetaSync(); lastSheetCheck = Date.now(); }
      if (!jobs.length) await new Promise((r) => setTimeout(r, 1000));
    } catch (e) {
      log.error("worker loop error", { error: (e as Error).message });
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  await db.$disconnect();
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stopping = true; log.info("worker stopping after current job"); });
main();
