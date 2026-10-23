-- Live transfer: the phone of each sheet tab's recruiter (one "Tab = +1..." per line).
ALTER TABLE "SystemSetting" ADD COLUMN     "recruiterTransfer" TEXT NOT NULL DEFAULT '';

UPDATE "SystemSetting" SET "recruiterTransfer" = E'Dennis = +18158461661';
