CREATE TABLE "LearningReport" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "stats" JSONB NOT NULL,
  "summary" TEXT,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LearningReport_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "LearningSuggestion" (
  "id" TEXT NOT NULL,
  "reportId" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "field" TEXT,
  "title" TEXT NOT NULL,
  "why" TEXT NOT NULL,
  "proposed" TEXT,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LearningSuggestion_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LearningSuggestion_orgId_status_idx" ON "LearningSuggestion"("orgId", "status");
ALTER TABLE "LearningSuggestion" ADD CONSTRAINT "LearningSuggestion_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "LearningReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
