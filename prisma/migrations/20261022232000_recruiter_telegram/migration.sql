-- AlterTable
ALTER TABLE "SystemSetting" ADD COLUMN     "recruiterTelegram" TEXT NOT NULL DEFAULT '';

-- Denis (tab "Dennis") is in the Telegram group; others are filled in on the Settings page.
UPDATE "SystemSetting" SET "recruiterTelegram" = 'Dennis = @tonyhope7';
