-- Recruiter statuses that stop Crystal's calls: "Processing by recruiter", "Declined by safety".
ALTER TYPE "HireStage" ADD VALUE 'PROCESSING' BEFORE 'APPLICATION';
ALTER TYPE "HireStage" ADD VALUE 'SAFETY_DECLINED' BEFORE 'NOT_HIRED';
