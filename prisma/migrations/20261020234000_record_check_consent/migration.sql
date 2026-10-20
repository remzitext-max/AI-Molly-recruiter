-- AlterTable
ALTER TABLE "SystemSetting" ADD COLUMN     "recordConsentEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "recordConsentText" TEXT NOT NULL DEFAULT 'I authorize {company} and its agents to obtain and review my motor vehicle record (MVR), my FMCSA Pre-Employment Screening Program (PSP) report, my previous employers'' safety performance history, and a limited query of the FMCSA Drug and Alcohol Clearinghouse, for hiring purposes only. I understand this is not a job offer. Typing my full name below is my electronic signature.';

-- CreateTable
CREATE TABLE "RecordCheckConsent" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecordCheckConsent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecordCheckConsent_leadId_idx" ON "RecordCheckConsent"("leadId");

-- AddForeignKey
ALTER TABLE "RecordCheckConsent" ADD CONSTRAINT "RecordCheckConsent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
