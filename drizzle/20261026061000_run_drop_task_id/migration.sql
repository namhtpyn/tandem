-- run_drop_task_id: legacy DBs keep the dead NOT NULL task_id (the squashed
-- baseline never ran there), which breaks every run insert — drop it when present.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'task_runs' AND column_name = 'task_id'
  ) THEN
    ALTER TABLE "task_runs" DROP COLUMN "task_id";
  END IF;
END $$;
