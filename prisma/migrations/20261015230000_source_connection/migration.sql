-- CreateTable
CREATE TABLE "SourceConnection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "campaignId" TEXT,
    "mapping" JSONB,
    "autoSync" BOOLEAN NOT NULL DEFAULT false,
    "pollMinutes" INTEGER NOT NULL DEFAULT 5,
    "lastSyncAt" TIMESTAMP(3),
    "lastSummary" JSONB,
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceConnection_pkey" PRIMARY KEY ("id")
);
