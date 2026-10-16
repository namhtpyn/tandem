-- review law: a task can be a supervisor review of another task's result
alter table "tandem_tasks" add column "review_of_task_id" text references "tandem_tasks"("id") on delete set null;
