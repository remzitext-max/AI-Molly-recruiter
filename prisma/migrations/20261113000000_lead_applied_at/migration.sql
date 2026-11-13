-- When the driver applied (the lead sheet's "Applied" column). Filled for new leads at import;
-- existing leads are filled once by the worker (src/lib/applied-backfill.ts).
ALTER TABLE "Lead" ADD COLUMN "appliedAt" TIMESTAMP(3);
CREATE INDEX "Lead_appliedAt_idx" ON "Lead"("appliedAt");
