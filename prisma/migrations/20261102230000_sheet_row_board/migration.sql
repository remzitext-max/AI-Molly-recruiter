-- The Board page: the driver's name and experience from the sheet, and since when the row has its status.
ALTER TABLE "SheetRow" ADD COLUMN "name" TEXT, ADD COLUMN "experience" TEXT, ADD COLUMN "statusAt" TIMESTAMP(3);

-- On-process rows already know since when; the rest count from the applied date.
UPDATE "SheetRow" r SET "statusAt" = d."statusSince", "name" = d."name", "experience" = d."experience"
FROM "SheetDriver" d WHERE d."orgId" = r."orgId" AND d."phoneE164" = r."phoneE164" AND d."status" = r."status";
UPDATE "SheetRow" SET "statusAt" = COALESCE("appliedAt", "seenAt") WHERE "statusAt" IS NULL;

CREATE INDEX "SheetRow_orgId_status_idx" ON "SheetRow"("orgId", "status");

-- The system is Crystal now: no "Molly" left in default texts or old task titles.
ALTER TABLE "SystemSetting" ALTER COLUMN "aiDisclosure" SET DEFAULT 'Hi, this is the AI recruiting assistant for {company}, calling on behalf of our recruiting team.';
ALTER TABLE "SystemSetting" ALTER COLUMN "voicemailMessage" SET DEFAULT 'Hi, this is the AI recruiting assistant for {company}, calling about a truck driving position you applied for. You can reach our recruiting team at {recruiterPhone}. Thanks!';
UPDATE "SystemSetting" SET "aiDisclosure" = REPLACE("aiDisclosure", 'calling on behalf of Molly, one of our recruiters.', 'calling on behalf of our recruiting team.');
UPDATE "SystemSetting" SET "voicemailMessage" = REPLACE(REPLACE("voicemailMessage", 'calling for Molly about', 'calling about'), 'You can reach Molly at', 'You can reach our recruiting team at');
UPDATE "Task" SET "title" = 'Driver question needs a recruiter''s answer' WHERE "title" = 'Driver question needs Molly''s answer';
