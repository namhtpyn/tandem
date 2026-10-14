CREATE TABLE IF NOT EXISTS "tandem_task_attachments" (
  "id" text PRIMARY KEY,
  "task_id" text NOT NULL REFERENCES "tandem_tasks"("id") ON DELETE CASCADE,
  "run_id" text,
  "kind" text NOT NULL DEFAULT 'input',
  "filename" text NOT NULL,
  "mime" text NOT NULL,
  "size" integer NOT NULL,
  "sha256" text NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "tandem_task_attachments_task_idx" ON "tandem_task_attachments" ("task_id", "created_at");
CREATE INDEX IF NOT EXISTS "tandem_task_attachments_run_idx" ON "tandem_task_attachments" ("run_id");
