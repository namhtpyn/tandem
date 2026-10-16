-- REVIEW LAW: per-reviewer verdict rows; per-run ACP sessions; retire review subtask link
create table if not exists "tandem_task_reviews" (
  "id" text primary key,
  "task_id" text not null references "tandem_tasks"("id") on delete cascade,
  "reviewer_id" text references "tandem_user"("id") on delete set null,
  "round" integer not null,
  "status" text not null default 'pending',
  "note" text,
  "source" text,
  "created_at" timestamp with time zone not null default now(),
  "decided_at" timestamp with time zone
);
create index if not exists "tandem_task_reviews_task_idx" on "tandem_task_reviews" ("task_id", "round");
alter table "tandem_task_runs" add column if not exists "session_id" text;
alter table "tandem_tasks" drop column if exists "review_of_task_id";
