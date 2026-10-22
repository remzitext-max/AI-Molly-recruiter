-- CreateTable
CREATE TABLE "SheetLeadStatus" (
    "phoneE164" TEXT NOT NULL,
    "tab" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SheetLeadStatus_pkey" PRIMARY KEY ("phoneE164")
);
