ALTER TABLE "environments" ADD COLUMN "last_probe_ok" boolean;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "last_probe_detail" text;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "last_probe_at" timestamp with time zone;