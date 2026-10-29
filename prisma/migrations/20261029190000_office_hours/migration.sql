ALTER TABLE "Organization" ADD COLUMN "officeHours" TEXT;
-- Recruiters' shifts in Tashkent time: the company's team ends at 3 AM, First team at 5 AM.
UPDATE "Organization" SET "officeHours" = CASE WHEN "isMain" THEN '17:00-03:00' ELSE '17:00-05:00' END;
ALTER TABLE "Lead" ADD COLUMN "recruiterCallAt" TIMESTAMP(3);

CREATE TABLE "SheetDriver" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "tab" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "name" TEXT,
    "experience" TEXT,
    "statusSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SheetDriver_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SheetDriver_orgId_phoneE164_key" ON "SheetDriver"("orgId", "phoneE164");
CREATE INDEX "SheetDriver_orgId_status_idx" ON "SheetDriver"("orgId", "status");
