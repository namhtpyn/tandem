-- run_message_backfill: link every run to its thread message (user design, 2026-10-26).
-- Fresh DBs: baseline already created message_id + FK — everything below is a no-op.
-- Legacy DBs (prod): adds the column, adopts links from task_message_runs, enforces NOT NULL + FK.
ALTER TABLE "task_runs" ADD COLUMN IF NOT EXISTS "message_id" text;
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('task_message_runs') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'task_runs' AND column_name = 'task_id') THEN
    -- strays first: runs with no ext link get a fresh message
    INSERT INTO task_messages (id, task_id, author_id, body, created_at)
    SELECT uuidv7(), r.task_id, r.employee_id, '', r.started_at
    FROM task_runs r
    WHERE NOT EXISTS (SELECT 1 FROM task_message_runs mr WHERE mr.run_id = r.id);
    UPDATE task_runs r
    SET message_id = mr.message_id
    FROM task_message_runs mr
    WHERE mr.run_id = r.id;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "task_runs" ALTER COLUMN "message_id" SET NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'task_runs_message_id_task_messages_id_fkey'
  ) THEN
    ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_message_id_task_messages_id_fkey"
      FOREIGN KEY ("message_id") REFERENCES "task_messages"("id") ON DELETE CASCADE;
  END IF;
END $$;
