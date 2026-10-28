ALTER TABLE "Lead" ADD COLUMN "recruiterStatus" TEXT;
ALTER TABLE "Lead" ADD COLUMN "recruiterStatusAt" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN "ownDriver" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Lead" ADD COLUMN "createdById" TEXT;
ALTER TABLE "User" ADD COLUMN "sheetTab" TEXT;

-- Copy the status recruiters already set in the lead sheet.
UPDATE "Lead" l SET "recruiterStatus" = s."status", "recruiterStatusAt" = s."seenAt"
FROM "SheetLeadStatus" s
WHERE s."phoneE164" = l."phoneE164" AND l."isDemo" = false AND s."status" <> '';
