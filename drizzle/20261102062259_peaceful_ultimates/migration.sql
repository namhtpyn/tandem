ALTER TABLE "tasks" ADD COLUMN "park_rearm_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "park_rearm_after" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "tasks_park_rearm_idx" ON "tasks" ("park_rearm_after") WHERE park_rearm_after is not null;