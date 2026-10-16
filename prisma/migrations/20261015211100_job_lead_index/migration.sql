-- Fast lookup of pending outreach per lead (used to prevent duplicate call jobs).
CREATE INDEX "Job_payload_leadId_active_idx" ON "Job" ((payload->>'leadId')) WHERE status IN ('PENDING', 'RUNNING');
