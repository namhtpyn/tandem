ALTER TABLE "tandem_task_statuses" ADD COLUMN IF NOT EXISTS "category" text NOT NULL DEFAULT 'backlog';
--> statement-breakpoint
UPDATE "tandem_task_statuses" SET "category" = CASE "id" WHEN 'todo' THEN 'ready' WHEN 'doing' THEN 'working' WHEN 'done' THEN 'done' ELSE 'backlog' END;
--> statement-breakpoint
DROP INDEX IF EXISTS "zz_noop";
--> statement-breakpoint
-- drop the old is_done column if it exists
ALTER TABLE "tandem_task_statuses" DROP COLUMN IF EXISTS "is_done";