-- Task runs: one row per agent dispatch. The output tail is capped at
-- TAIL_MAX_LINES lines server-side so the live payload stays small.

CREATE TABLE "tandem_task_runs" (
  "id" text PRIMARY KEY,
  "task_id" text NOT NULL REFERENCES "tandem_tasks"("id") ON DELETE CASCADE,
  "employee_id" text REFERENCES "tandem_user"("id") ON DELETE SET NULL,
  "environment_id" text,
  "status" text NOT NULL DEFAULT 'running', -- running | done | failed
  "exit_code" integer,
  "output" text NOT NULL DEFAULT '',
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX "tandem_task_runs_task_idx" ON "tandem_task_runs" ("task_id", "started_at");
