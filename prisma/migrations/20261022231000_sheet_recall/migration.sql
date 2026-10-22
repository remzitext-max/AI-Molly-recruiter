-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "recallMaxDays" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "recallMinDays" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "recallPerDay" INTEGER NOT NULL DEFAULT 25;

-- The owner chose (2026-10-22): re-call "No answer" sheet leads that applied 7-60 days ago.
UPDATE "Campaign" SET "recallMinDays" = 7 WHERE "id" = 'tbt_main';
