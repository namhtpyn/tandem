ALTER TABLE "tandem_tasks" ALTER COLUMN "status" SET DEFAULT '01a14743-43f4-7053-a698-5b4ef36ed046';

-- Bootstrap remap (one-time data fix — drizzle-kit is DDL-only): move existing
-- DBs from the semantic status ids onto the fixed uuid constants (shared/status.ts).
-- Idempotent: every statement is a no-op once ids are already uuids.
--> statement-breakpoint
update "tandem_tasks" set "status" = '01a14743-43f4-7053-a698-5b4ef36ed046' where "status" = 'todo';
--> statement-breakpoint
update "tandem_tasks" set "status" = '01a14743-43f5-759d-a00e-9ccda502cc88' where "status" = 'doing';
--> statement-breakpoint
update "tandem_tasks" set "status" = '01a14743-43f5-759d-a00e-a20a36faa315' where "status" = 'done';
--> statement-breakpoint
update "tandem_tasks" set "status" = '01a14743-43f5-759d-a00e-a424b478f2fa' where "status" = 'waiting-answer';
--> statement-breakpoint
update "tandem_tasks" set "status" = '01a14743-43f5-759d-a00e-a90831248ea5' where "status" = 'in-review';
--> statement-breakpoint
update "tandem_tasks" set "status" = '01a14743-43f5-759d-a00e-ada27e46c2f8' where "status" = 'blocked';
--> statement-breakpoint
update "tandem_tasks" set "status" = '01a14743-43f5-759d-a00e-b0f2a5a04f4c' where "status" = 'cancelled';
--> statement-breakpoint
update "tandem_task_statuses" set "next_ids" = array_replace("next_ids", 'todo', '01a14743-43f4-7053-a698-5b4ef36ed046');
--> statement-breakpoint
update "tandem_task_statuses" set "next_ids" = array_replace("next_ids", 'doing', '01a14743-43f5-759d-a00e-9ccda502cc88');
--> statement-breakpoint
update "tandem_task_statuses" set "next_ids" = array_replace("next_ids", 'done', '01a14743-43f5-759d-a00e-a20a36faa315');
--> statement-breakpoint
update "tandem_task_statuses" set "next_ids" = array_replace("next_ids", 'waiting-answer', '01a14743-43f5-759d-a00e-a424b478f2fa');
--> statement-breakpoint
update "tandem_task_statuses" set "next_ids" = array_replace("next_ids", 'in-review', '01a14743-43f5-759d-a00e-a90831248ea5');
--> statement-breakpoint
update "tandem_task_statuses" set "next_ids" = array_replace("next_ids", 'blocked', '01a14743-43f5-759d-a00e-ada27e46c2f8');
--> statement-breakpoint
update "tandem_task_statuses" set "next_ids" = array_replace("next_ids", 'cancelled', '01a14743-43f5-759d-a00e-b0f2a5a04f4c');
--> statement-breakpoint
update "tandem_task_statuses" set "id" = '01a14743-43f4-7053-a698-5b4ef36ed046' where "id" = 'todo';
--> statement-breakpoint
update "tandem_task_statuses" set "id" = '01a14743-43f5-759d-a00e-9ccda502cc88' where "id" = 'doing';
--> statement-breakpoint
update "tandem_task_statuses" set "id" = '01a14743-43f5-759d-a00e-a20a36faa315' where "id" = 'done';
--> statement-breakpoint
update "tandem_task_statuses" set "id" = '01a14743-43f5-759d-a00e-a424b478f2fa' where "id" = 'waiting-answer';
--> statement-breakpoint
update "tandem_task_statuses" set "id" = '01a14743-43f5-759d-a00e-a90831248ea5' where "id" = 'in-review';
--> statement-breakpoint
update "tandem_task_statuses" set "id" = '01a14743-43f5-759d-a00e-ada27e46c2f8' where "id" = 'blocked';
--> statement-breakpoint
update "tandem_task_statuses" set "id" = '01a14743-43f5-759d-a00e-b0f2a5a04f4c' where "id" = 'cancelled';
