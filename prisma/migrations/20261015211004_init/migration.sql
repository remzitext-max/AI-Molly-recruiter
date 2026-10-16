-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'RECRUITER');

-- CreateEnum
CREATE TYPE "PipelineStatus" AS ENUM ('NEW', 'NEEDS_PERMISSION', 'NEEDS_TIMEZONE', 'QUEUED', 'CONTACTING', 'CALLBACK_SCHEDULED', 'INTERESTED', 'NOT_INTERESTED', 'DOCS_REQUESTED', 'DOCS_RECEIVED', 'HANDOFF_READY', 'HANDED_OFF', 'OPTED_OUT', 'CLOSED');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('NONE', 'REQUESTED', 'RECEIVED', 'EXPIRED', 'DELETED');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('SCHEDULED', 'DIALING', 'RINGING', 'IN_PROGRESS', 'COMPLETED', 'NO_ANSWER', 'BUSY', 'VOICEMAIL', 'FAILED', 'UNKNOWN', 'CANCELED');

-- CreateEnum
CREATE TYPE "CallOutcome" AS ENUM ('INTERESTED', 'NOT_INTERESTED', 'CALLBACK', 'OPT_OUT', 'HUMAN_REQUESTED', 'VOICEMAIL_LEFT', 'NO_CONTACT', 'WRONG_NUMBER', 'INCOMPLETE', 'TECHNICAL_FAILURE');

-- CreateEnum
CREATE TYPE "PermissionScope" AS ENUM ('AI_CALL', 'SMS', 'MANUAL_CALL');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('CALLBACK', 'HANDOFF', 'TRANSFER_FAILED', 'UNANSWERED_QUESTION', 'REVIEW_UNCLEAR', 'RESOLVE_TIMEZONE', 'RECORD_PERMISSION', 'TECHNICAL_ISSUE');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE', 'CANCELED');

-- CreateEnum
CREATE TYPE "HandoffReason" AS ENUM ('READY', 'HUMAN_REQUESTED', 'UNKNOWN_QUESTION', 'ELIGIBILITY_EXCEPTION', 'TECHNICAL');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('NOT_ATTEMPTED', 'ATTEMPTING', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'DEAD', 'CANCELED');

-- CreateEnum
CREATE TYPE "OfferVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AssignmentMode" AS ENUM ('MANUAL', 'ROUND_ROBIN');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'RECRUITER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "inRoundRobin" BOOLEAN NOT NULL DEFAULT true,
    "availableForTransfer" BOOLEAN NOT NULL DEFAULT false,
    "transferPhoneE164" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "globalPause" BOOLEAN NOT NULL DEFAULT false,
    "liveContactEnabled" BOOLEAN NOT NULL DEFAULT false,
    "contactPolicyConfirmedAt" TIMESTAMP(3),
    "contactPolicyConfirmedById" TEXT,
    "contactPolicyNotes" TEXT,
    "requireCallPermission" BOOLEAN NOT NULL DEFAULT true,
    "requireSmsPermission" BOOLEAN NOT NULL DEFAULT true,
    "allowVerbalSmsConsent" BOOLEAN NOT NULL DEFAULT true,
    "recordingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "recordingNotice" TEXT NOT NULL DEFAULT 'This call may be recorded for quality and recruiting records.',
    "documentRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "uploadLinkTtlMinutes" INTEGER NOT NULL DEFAULT 60,
    "maxUploadBytes" INTEGER NOT NULL DEFAULT 10485760,
    "screeningConfig" JSONB,
    "aiDisclosure" TEXT NOT NULL DEFAULT 'Hi, this is the AI recruiting assistant for {company}, calling on behalf of Molly, one of our recruiters.',
    "voicemailMessage" TEXT NOT NULL DEFAULT 'Hi, this is the AI recruiting assistant for {company}, calling for Molly about a truck driving position you applied for. You can reach Molly at {recruiterPhone}. Thanks!',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "offerId" TEXT,
    "assignmentMode" "AssignmentMode" NOT NULL DEFAULT 'ROUND_ROBIN',
    "rrCursor" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "retryDelayMinutes" INTEGER NOT NULL DEFAULT 240,
    "contactWindowStart" TEXT NOT NULL DEFAULT '09:00',
    "contactWindowEnd" TEXT NOT NULL DEFAULT '19:00',
    "contactDays" TEXT NOT NULL DEFAULT '1,2,3,4,5,6',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "firstName" TEXT,
    "lastName" TEXT,
    "phoneE164" TEXT NOT NULL,
    "phoneRaw" TEXT,
    "email" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "timezone" TEXT,
    "timezoneSource" TEXT,
    "pipelineStatus" "PipelineStatus" NOT NULL DEFAULT 'NEW',
    "documentStatus" "DocumentStatus" NOT NULL DEFAULT 'NONE',
    "optedOutAt" TIMESTAMP(3),
    "assignedToId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "activeAttemptId" TEXT,
    "nextContactAt" TIMESTAMP(3),
    "callbackAt" TIMESTAMP(3),
    "queueReason" TEXT,
    "lastOfferVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadSourceRecord" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceRecordId" TEXT NOT NULL,
    "importBatchId" TEXT,
    "raw" JSONB,
    "syncStatus" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadSourceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentHistory" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "fromUserId" TEXT,
    "toUserId" TEXT,
    "method" TEXT NOT NULL,
    "byUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssignmentHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactPermission" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "scope" "PermissionScope" NOT NULL,
    "source" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL,
    "evidence" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreeningField" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "reportedValue" TEXT,
    "rawUtterance" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CAPTURED',
    "callAttemptId" TEXT,
    "verifiedValue" TEXT,
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScreeningField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallAttempt" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT NOT NULL,
    "providerCallId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'OUTBOUND',
    "status" "CallStatus" NOT NULL DEFAULT 'SCHEDULED',
    "statusRank" INTEGER NOT NULL DEFAULT 0,
    "outcome" "CallOutcome",
    "offerVersionId" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "summary" TEXT,
    "transcript" JSONB,
    "recordingKey" TEXT,
    "recordingNoticeGiven" BOOLEAN NOT NULL DEFAULT false,
    "metrics" JSONB,
    "personaKey" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "direction" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "idempotencyKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadToken" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "maxFiles" INTEGER NOT NULL DEFAULT 4,
    "filesUsed" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "kind" TEXT NOT NULL DEFAULT 'CDL',
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleteAfter" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "extraction" JSONB,
    "extractionReviewedById" TEXT,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "type" "TaskType" NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "assignedToId" TEXT,
    "dueAt" TIMESTAMP(3),
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Handoff" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "recruiterId" TEXT,
    "reason" "HandoffReason" NOT NULL,
    "transferStatus" "TransferStatus" NOT NULL DEFAULT 'NOT_ATTEMPTED',
    "callAttemptId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Handoff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnansweredQuestion" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "callAttemptId" TEXT,
    "question" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "answer" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnansweredQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "activeVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferVersion" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "OfferVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "synthetic" BOOLEAN NOT NULL DEFAULT false,
    "facts" JSONB NOT NULL,
    "notes" TEXT,
    "createdById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfferVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerVoiceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NOT_CREATED',
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "consentScope" TEXT,
    "consentDate" TIMESTAMP(3),
    "consentRecordedById" TEXT,
    "consentNotes" TEXT,
    "verificationStatus" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoicePreview" (
    "id" TEXT NOT NULL,
    "voiceProfileId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "audioKey" TEXT,
    "synthetic" BOOLEAN NOT NULL DEFAULT true,
    "latencyMs" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoicePreview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREVIEW',
    "mapping" JSONB NOT NULL,
    "rows" JSONB NOT NULL,
    "summary" JSONB,
    "campaignId" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "leadId" TEXT,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_activeAttemptId_key" ON "Lead"("activeAttemptId");

-- CreateIndex
CREATE INDEX "Lead_pipelineStatus_idx" ON "Lead"("pipelineStatus");

-- CreateIndex
CREATE INDEX "Lead_assignedToId_idx" ON "Lead"("assignedToId");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_orgId_phoneE164_key" ON "Lead"("orgId", "phoneE164");

-- CreateIndex
CREATE UNIQUE INDEX "LeadSourceRecord_sourceSystem_sourceRecordId_key" ON "LeadSourceRecord"("sourceSystem", "sourceRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "Suppression_phoneE164_key" ON "Suppression"("phoneE164");

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningField_leadId_key_key" ON "ScreeningField"("leadId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "CallAttempt_providerCallId_key" ON "CallAttempt"("providerCallId");

-- CreateIndex
CREATE UNIQUE INDEX "CallAttempt_idempotencyKey_key" ON "CallAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CallAttempt_leadId_status_idx" ON "CallAttempt"("leadId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Message_providerMessageId_key" ON "Message"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_idempotencyKey_key" ON "Message"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "UploadToken_tokenHash_key" ON "UploadToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Document_storageKey_key" ON "Document"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "Task_dedupeKey_key" ON "Task"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "OfferVersion_offerId_version_key" ON "OfferVersion"("offerId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceProfile_name_key" ON "VoiceProfile"("name");

-- CreateIndex
CREATE INDEX "ActivityEvent_leadId_createdAt_idx" ON "ActivityEvent"("leadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Job_idempotencyKey_key" ON "Job"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Job_status_runAt_idx" ON "Job"("status", "runAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_eventId_key" ON "WebhookEvent"("provider", "eventId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSourceRecord" ADD CONSTRAINT "LeadSourceRecord_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentHistory" ADD CONSTRAINT "AssignmentHistory_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactPermission" ADD CONSTRAINT "ContactPermission_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningField" ADD CONSTRAINT "ScreeningField_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallAttempt" ADD CONSTRAINT "CallAttempt_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadToken" ADD CONSTRAINT "UploadToken_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Handoff" ADD CONSTRAINT "Handoff_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnansweredQuestion" ADD CONSTRAINT "UnansweredQuestion_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferVersion" ADD CONSTRAINT "OfferVersion_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoicePreview" ADD CONSTRAINT "VoicePreview_voiceProfileId_fkey" FOREIGN KEY ("voiceProfileId") REFERENCES "VoiceProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
