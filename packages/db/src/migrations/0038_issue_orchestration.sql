ALTER TABLE "issues"
  ADD COLUMN "orchestration_policy" jsonb,
  ADD COLUMN "orchestration_state" jsonb;
