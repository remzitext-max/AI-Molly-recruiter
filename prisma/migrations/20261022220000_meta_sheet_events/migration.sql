-- CreateTable
CREATE TABLE "MetaSheetEvent" (
    "phoneE164" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "tab" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetaSheetEvent_pkey" PRIMARY KEY ("phoneE164","eventName")
);
