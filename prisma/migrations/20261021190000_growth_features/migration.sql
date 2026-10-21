-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "reengageAfterDays" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "fbAd" TEXT,
ADD COLUMN     "fbCampaign" TEXT,
ADD COLUMN     "fbForm" TEXT,
ADD COLUMN     "fbLeadId" TEXT,
ADD COLUMN     "reengagedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SystemSetting" ADD COLUMN     "fitRules" JSONB,
ADD COLUMN     "missedCallSms" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "missedCallSmsText" TEXT NOT NULL DEFAULT '{company} recruiting team: Hi {first}, it''s {persona}. We just tried to call you about the truck driving job you applied for. When is a good time to call you back? Reply STOP to opt out.';
