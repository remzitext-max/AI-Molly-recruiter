-- CreateEnum
CREATE TYPE "HireStage" AS ENUM ('NONE', 'APPLICATION', 'ORIENTATION', 'HIRED', 'NOT_HIRED');

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "hireNote" TEXT,
ADD COLUMN     "hireStage" "HireStage" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "hireStageAt" TIMESTAMP(3),
ADD COLUMN     "hiredAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Lead_hireStage_idx" ON "Lead"("hireStage");
