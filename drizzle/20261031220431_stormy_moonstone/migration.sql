CREATE INDEX "task_runs_status_idx" ON "task_runs" ("status");--> statement-breakpoint
CREATE INDEX "tasks_parent_task_idx" ON "tasks" ("parent_task_id");