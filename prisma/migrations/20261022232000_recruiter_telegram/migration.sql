-- AlterTable
ALTER TABLE "SystemSetting" ADD COLUMN     "recruiterTelegram" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Lead" ADD COLUMN     "telegramThread" TEXT;

-- Recruiters in the Telegram group (owner, 2026-10-22). Paul, Marcus and Luke have left:
-- their leads show "Before processed by <tab>".
UPDATE "SystemSetting" SET "recruiterTelegram" = E'Molly = @HRMollyRobertson\nMona = @mona_bennett\nBen = @Ben_ThompsonHr\nDaniel = @daniel_m00re\nDennis = @tonyhope7';
