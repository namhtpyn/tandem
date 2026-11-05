CREATE TABLE "channel_outbox" (
	"id" text PRIMARY KEY,
	"adapter" text NOT NULL,
	"thread_ref" text NOT NULL,
	"task_id" text NOT NULL,
	"run_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_outbox_relay_uq" ON "channel_outbox" ("adapter","run_id","thread_ref");--> statement-breakpoint
CREATE INDEX "channel_outbox_unprocessed_idx" ON "channel_outbox" ("processed_at") WHERE "processed_at" is null;--> statement-breakpoint
ALTER TABLE "channel_outbox" ADD CONSTRAINT "channel_outbox_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;