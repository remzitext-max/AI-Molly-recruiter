-- One application (sheet row with an Applied time) per LeadID of a team's lead sheet.
CREATE TABLE "SheetApplication" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "phoneE164" TEXT,
    "name" TEXT,
    "appliedAt" TIMESTAMP(3) NOT NULL,
    "tab" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SheetApplication_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SheetApplication_orgId_key_key" ON "SheetApplication"("orgId", "key");
CREATE INDEX "SheetApplication_orgId_appliedAt_idx" ON "SheetApplication"("orgId", "appliedAt");
CREATE INDEX "SheetApplication_orgId_phoneE164_idx" ON "SheetApplication"("orgId", "phoneE164");

-- When every tab of a team's lead sheet was last read.
ALTER TABLE "Organization" ADD COLUMN "sheetReadAt" TIMESTAMP(3);
