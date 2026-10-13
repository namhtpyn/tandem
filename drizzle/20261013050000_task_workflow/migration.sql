-- Task workflow: waiting-answer + review states, owner/reviewers, activity feed.

-- 1) new workflow categories on workspace statuses
--> statement-breakpoint
UPDATE tandem_task_statuses SET category = 'in_review' WHERE id = 'in_review';
--> statement-breakpoint
-- seed the two workflow statuses if absent (stable ids; positions after 'done')
INSERT INTO tandem_task_statuses (id, name, color, position, category, next_ids)
SELECT 'waiting-answer', 'Waiting answer', 'warning', 3, 'waiting_answer', '{todo}'::text[]
WHERE NOT EXISTS (SELECT 1 FROM tandem_task_statuses WHERE id = 'waiting-answer');
--> statement-breakpoint
INSERT INTO tandem_task_statuses (id, name, color, position, category, next_ids)
SELECT 'in-review', 'In review', 'info', 4, 'in_review', '{doing,done}'::text[]
WHERE NOT EXISTS (SELECT 1 FROM tandem_task_statuses WHERE id = 'in-review');
--> statement-breakpoint
-- transition wiring for seeded flow: todo->doing, doing->waiting-answer/in-review/done
UPDATE tandem_task_statuses SET next_ids = '{doing}'::text[] WHERE id = 'todo';
--> statement-breakpoint
UPDATE tandem_task_statuses SET next_ids = '{todo,waiting-answer,in-review,done}'::text[] WHERE id = 'doing';
--> statement-breakpoint
UPDATE tandem_task_statuses SET next_ids = '{doing,done}'::text[] WHERE id = 'in-review';
--> statement-breakpoint
UPDATE tandem_task_statuses SET next_ids = '{doing}'::text[] WHERE id = 'waiting-answer';
--> statement-breakpoint
-- 2) tasks: owner, reviewers, question routing
ALTER TABLE tandem_tasks
  ADD COLUMN "owner_id" text REFERENCES tandem_user("id") ON DELETE SET NULL,
  ADD COLUMN "reviewers" text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN "question_holder_id" text REFERENCES tandem_user("id") ON DELETE SET NULL,
  ADD COLUMN "question_chain" text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN "review_approvals" text[] NOT NULL DEFAULT '{}'::text[];
--> statement-breakpoint
-- 3) activity feed
CREATE TABLE "tandem_task_activity" (
  "id" text PRIMARY KEY,
  "task_id" text NOT NULL REFERENCES "tandem_tasks"("id") ON DELETE CASCADE,
  "kind" text NOT NULL, -- question | answer | forward | note | verdict | status
  "author_id" text REFERENCES "tandem_user"("id") ON DELETE SET NULL,
  "body" text NOT NULL DEFAULT '',
  "meta" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "tandem_task_activity_task_idx" ON "tandem_task_activity" ("task_id", "created_at");
