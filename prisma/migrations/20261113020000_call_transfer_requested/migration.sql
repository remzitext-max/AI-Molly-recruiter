-- When Crystal handed a call to a recruiter. Such a call may run on past her own 15 minutes,
-- and the phone line guard keeps counting it until it ends.
ALTER TABLE "CallAttempt" ADD COLUMN "transferRequestedAt" TIMESTAMP(3);
