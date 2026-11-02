-- Every lead sheet row (phone, tab, status, applied date) for the dashboards and the Recruiters page.
CREATE TABLE "SheetRow" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "tab" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SheetRow_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SheetRow_orgId_phoneE164_key" ON "SheetRow"("orgId", "phoneE164");
CREATE INDEX "SheetRow_orgId_appliedAt_idx" ON "SheetRow"("orgId", "appliedAt");
