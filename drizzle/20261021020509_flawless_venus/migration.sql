-- enum-value remap (law: SCREAMING_SNAKE_CASE as-const enums); guarded -> idempotent
UPDATE "user" SET "role" = upper("role") WHERE "role" IN ('admin', 'employee', 'viewer');
UPDATE "projects" SET "status" = upper("status") WHERE "status" IN ('active', 'archived');
UPDATE "task_obligations" SET "role" = upper("role") WHERE "role" IN ('answer', 'approval');
UPDATE "task_obligations" SET "status" = upper("status") WHERE "status" IN ('pending', 'fulfilled', 'cancelled');
UPDATE "task_proposals" SET "status" = upper("status") WHERE "status" IN ('proposed', 'executed', 'rejected');
UPDATE "task_proposals" SET "kind" = upper("kind") WHERE "kind" IN ('subtasks', 'reassign');
UPDATE "task_runs" SET "status" = upper("status") WHERE "status" IN ('running', 'done', 'failed');
UPDATE "task_reviews" SET "status" = upper("status") WHERE "status" IN ('pending', 'approved', 'change_requested', 'rejected');
UPDATE "environments" SET "secret_usage" = upper("secret_usage") WHERE "secret_usage" IN ('ssh-key', 'password');
UPDATE "task_activity" SET "kind" = upper("kind") WHERE "kind" IN ('question', 'answer', 'forward', 'note', 'verdict', 'status');
--> statement-breakpoint
ALTER TABLE "environments" ALTER COLUMN "secret_usage" SET DEFAULT 'SSH_KEY';--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';--> statement-breakpoint
ALTER TABLE "task_obligations" ALTER COLUMN "status" SET DEFAULT 'PENDING';--> statement-breakpoint
ALTER TABLE "task_proposals" ALTER COLUMN "status" SET DEFAULT 'PROPOSED';--> statement-breakpoint
ALTER TABLE "task_reviews" ALTER COLUMN "status" SET DEFAULT 'PENDING';--> statement-breakpoint
ALTER TABLE "task_runs" ALTER COLUMN "status" SET DEFAULT 'RUNNING';--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "role" SET DEFAULT 'VIEWER';