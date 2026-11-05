CREATE TABLE "channel_events" (
	"id" text PRIMARY KEY,
	"channel" text NOT NULL,
	"adapter" text NOT NULL,
	"external_id" text NOT NULL,
	"thread_ref" text NOT NULL,
	"sender" text NOT NULL,
	"body" text NOT NULL,
	"raw" jsonb DEFAULT '{}' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "channel_threads" (
	"id" text PRIMARY KEY,
	"channel" text NOT NULL,
	"thread_ref" text NOT NULL,
	"task_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_events_channel_external_uq" ON "channel_events" ("channel","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_threads_channel_thread_uq" ON "channel_threads" ("channel","thread_ref");--> statement-breakpoint
ALTER TABLE "channel_threads" ADD CONSTRAINT "channel_threads_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;