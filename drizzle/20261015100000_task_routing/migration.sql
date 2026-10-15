-- Task routing: pending obligations (single source for "who acts next"), append-only
-- assignee history, subtask nesting (parent_task_id), blocked/abandoned/cancelled statuses.
-- Replaces question_holder_id and review_approvals (backfilled into obligations, then dropped).

-- 1) statuses: blocked (paused), cancelled + abandoned (terminal)
INSERT INTO "tandem_task_statuses" ("id", "name", "color", "position", "category", "next_ids")
SELECT 'blocked', 'Blocked', 'error', 5, 'paused', '{todo,blocked}'::text[]
WHERE NOT EXISTS (SELECT 1 FROM tandem_task_statuses WHERE id = 'blocked');
INSERT INTO "tandem_task_statuses" ("id", "name", "color", "position", "category", "next_ids")
SELECT 'cancelled', 'Cancelled', 'neutral', 6, 'cancelled', '{}'::text[]
WHERE NOT EXISTS (SELECT 1 FROM tandem_task_statuses WHERE id = 'cancelled');
INSERT INTO "tandem_task_statuses" ("id", "name", "color", "position", "category", "next_ids")
SELECT 'abandoned', 'Abandoned', 'neutral', 7, 'cancelled', '{}'::text[]
WHERE NOT EXISTS (SELECT 1 FROM tandem_task_statuses WHERE id = 'abandoned');
-- wire the seeded flow to/from blocked
UPDATE tandem_task_statuses SET next_ids = '{todo,waiting-answer,in-review,done,blocked}'::text[] WHERE id = 'doing';
UPDATE tandem_task_statuses SET next_ids = '{doing,cancelled,abandoned}'::text[] WHERE id = 'todo';

-- 2) pending obligations: who owes what on a task (answer a question, approve a review)
CREATE TABLE "tandem_task_obligations" (
  "id" text PRIMARY KEY,
  "task_id" text NOT NULL REFERENCES "tandem_tasks"("id") ON DELETE CASCADE,
  "employee_id" text REFERENCES "tandem_user"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "resolved_at" timestamptz,
  "resolved_by" text REFERENCES "tandem_user"("id") ON DELETE SET NULL
);
CREATE INDEX "tandem_task_obligations_task_idx" ON "tandem_task_obligations" ("task_id", "role", "status");
CREATE INDEX "tandem_task_obligations_employee_idx" ON "tandem_task_obligations" ("employee_id", "status");

-- 3) assignee history (append-only; current assignee stays denormalized on the task)
CREATE TABLE "tandem_task_assignments" (
  "id" text PRIMARY KEY,
  "task_id" text NOT NULL REFERENCES "tandem_tasks"("id") ON DELETE CASCADE,
  "employee_id" text REFERENCES "tandem_user"("id") ON DELETE SET NULL,
  "reason" text NOT NULL DEFAULT '',
  "actor_id" text REFERENCES "tandem_user"("id") ON DELETE SET NULL,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "ended_at" timestamptz
);
CREATE INDEX "tandem_task_assignments_task_idx" ON "tandem_task_assignments" ("task_id", "started_at");

-- 4) subtasks: children are full tasks; parent gates on children via statuses
ALTER TABLE "tandem_tasks" ADD COLUMN "parent_task_id" text REFERENCES "tandem_tasks"("id") ON DELETE SET NULL;
ALTER TABLE "tandem_tasks" ADD COLUMN "pre_block_status" text;
CREATE INDEX "tandem_tasks_parent_idx" ON "tandem_tasks" ("parent_task_id");

-- 5) agent proposals ([SUBTASKS] / [REASSIGN] from run envelopes; decision model / human confirms)
CREATE TABLE "tandem_task_proposals" (
  "id" text PRIMARY KEY,
  "task_id" text NOT NULL REFERENCES "tandem_tasks"("id") ON DELETE CASCADE,
  "run_id" text REFERENCES "tandem_task_runs"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}',
  "status" text NOT NULL DEFAULT 'proposed',
  "decision_note" text NOT NULL DEFAULT '',
  "decided_by" text REFERENCES "tandem_user"("id") ON DELETE SET NULL,
  "decided_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "tandem_task_proposals_task_idx" ON "tandem_task_proposals" ("task_id", "status");

-- 6) backfill obligations from the old columns
INSERT INTO "tandem_task_obligations" ("id", "task_id", "employee_id", "role", "status", "created_at")
SELECT gen_random_uuid()::text, t.id, t.question_holder_id, 'answer', 'pending', t.updated_at
FROM tandem_tasks t WHERE t.question_holder_id IS NOT NULL AND t.status = 'waiting-answer';

INSERT INTO "tandem_task_obligations" ("id", "task_id", "employee_id", "role", "status", "created_at", "resolved_at", "resolved_by")
SELECT gen_random_uuid()::text, t.id, r, 'approval', 'fulfilled', t.updated_at, t.updated_at, r
FROM tandem_tasks t, unnest(t.review_approvals) AS r
WHERE t.status = 'in-review';

INSERT INTO "tandem_task_obligations" ("id", "task_id", "employee_id", "role", "status", "created_at")
SELECT gen_random_uuid()::text, t.id, r, 'approval', 'pending', t.updated_at
FROM tandem_tasks t, unnest(t.reviewers) AS r
WHERE t.status = 'in-review' AND NOT (r = ANY(t.review_approvals));

-- 7) backfill assignment history: one open row per task's current assignee
INSERT INTO "tandem_task_assignments" ("id", "task_id", "employee_id", "reason", "started_at")
SELECT gen_random_uuid()::text, id, assignee_id, 'backfill', created_at
FROM tandem_tasks WHERE assignee_id IS NOT NULL;

-- 8) drop the replaced columns
ALTER TABLE "tandem_tasks" DROP COLUMN IF EXISTS "question_holder_id";
ALTER TABLE "tandem_tasks" DROP COLUMN IF EXISTS "review_approvals";
