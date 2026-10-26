CREATE TABLE "task_message_activities" (
	"message_id" text PRIMARY KEY,
	"payload" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_message_runs" (
	"message_id" text PRIMARY KEY,
	"run_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_messages" (
	"id" text PRIMARY KEY,
	"task_id" text NOT NULL,
	"author_id" uuid,
	"body" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "task_messages_task_idx" ON "task_messages" ("task_id","created_at");--> statement-breakpoint
ALTER TABLE "task_message_activities" ADD CONSTRAINT "task_message_activities_message_id_task_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "task_messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_message_runs" ADD CONSTRAINT "task_message_runs_message_id_task_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "task_messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_message_runs" ADD CONSTRAINT "task_message_runs_run_id_task_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "task_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_messages" ADD CONSTRAINT "task_messages_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_messages" ADD CONSTRAINT "task_messages_author_id_user_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE SET NULL;
-- backfill: one thread message per existing activity row (payload = activity meta)
INSERT INTO task_messages (id, task_id, author_id, body, created_at)
SELECT id, task_id, author_id, body, created_at FROM task_activity;
INSERT INTO task_message_activities (message_id, payload)
SELECT id, jsonb_build_object('kind', kind, 'meta', meta) FROM task_activity;

-- backfill: one thread message per run (body rendered from the run row; started_at keeps ordering)
INSERT INTO task_messages (id, task_id, author_id, body, created_at)
SELECT id, task_id, employee_id, '', started_at FROM task_runs;
INSERT INTO task_message_runs (message_id, run_id)
SELECT id, id FROM task_runs;
