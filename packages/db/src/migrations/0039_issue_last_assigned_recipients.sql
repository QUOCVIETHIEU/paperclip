ALTER TABLE "issues"
  ADD COLUMN "last_assigned_agent_id" uuid REFERENCES "agents"("id");

ALTER TABLE "issues"
  ADD COLUMN "last_assigned_user_id" text;

UPDATE "issues"
SET
  "last_assigned_agent_id" = "assignee_agent_id",
  "last_assigned_user_id" = "assignee_user_id"
WHERE "assignee_agent_id" IS NOT NULL
   OR "assignee_user_id" IS NOT NULL;

UPDATE "issues" AS "i"
SET "last_assigned_agent_id" = "latest_checkout"."agent_id"
FROM (
  SELECT DISTINCT ON ("entity_id")
    "entity_id",
    "agent_id"
  FROM "activity_log"
  WHERE "entity_type" = 'issue'
    AND "action" = 'issue.checked_out'
    AND "agent_id" IS NOT NULL
  ORDER BY "entity_id", "created_at" DESC
) AS "latest_checkout"
WHERE "i"."last_assigned_agent_id" IS NULL
  AND "i"."last_assigned_user_id" IS NULL
  AND "latest_checkout"."entity_id" = "i"."id"::text;
