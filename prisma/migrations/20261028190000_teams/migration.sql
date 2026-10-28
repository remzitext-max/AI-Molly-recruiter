ALTER TABLE "Organization" ADD COLUMN "isMain" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Organization" ADD COLUMN "sheetSpreadsheetId" TEXT;
ALTER TABLE "Organization" ADD COLUMN "sheetPoolTab" TEXT;
ALTER TABLE "Organization" ADD COLUMN "transferPhoneE164" TEXT;
ALTER TABLE "Organization" ADD COLUMN "telegramChatId" TEXT;
