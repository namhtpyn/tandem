CREATE TABLE IF NOT EXISTS "tandem_task_statuses" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"color" text NOT NULL DEFAULT 'neutral',
	"position" integer NOT NULL DEFAULT 0,
	"is_done" boolean NOT NULL DEFAULT false,
	"next_ids" text[] NOT NULL DEFAULT '{}'::text[],
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO "tandem_task_statuses" ("id", "name", "color", "position", "is_done", "next_ids") VALUES
	('todo', 'To do', 'neutral', 0, false, ARRAY['doing']::text[]),
	('doing', 'Doing', 'warning', 1, false, ARRAY['todo', 'done']::text[]),
	('done', 'Done', 'success', 2, true, ARRAY['doing']::text[])
ON CONFLICT ("id") DO NOTHING;