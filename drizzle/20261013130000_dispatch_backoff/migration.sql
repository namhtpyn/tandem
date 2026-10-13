ALTER TABLE "tandem_tasks" ADD COLUMN IF NOT EXISTS "dispatch_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tandem_tasks" ADD COLUMN IF NOT EXISTS "fail_streak" integer NOT NULL DEFAULT 0;
