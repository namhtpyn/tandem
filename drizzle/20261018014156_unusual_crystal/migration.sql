ALTER TABLE "account" DROP CONSTRAINT IF EXISTS tandem_account_user_id_tandem_user_id_fkey;

--> statement-breakpoint
ALTER TABLE "ai_employees" DROP CONSTRAINT IF EXISTS tandem_ai_employees_user_id_tandem_user_id_fkey;

--> statement-breakpoint
ALTER TABLE "apikey" DROP CONSTRAINT IF EXISTS tandem_apikey_reference_id_tandem_user_id_fkey;

--> statement-breakpoint
ALTER TABLE "employee_supervisors" DROP CONSTRAINT IF EXISTS tandem_employee_supervisors_employee_id_tandem_user_id_fkey;

--> statement-breakpoint
ALTER TABLE "employee_supervisors" DROP CONSTRAINT IF EXISTS tandem_employee_supervisors_supervisor_id_tandem_user_id_fkey;

--> statement-breakpoint
ALTER TABLE "session" DROP CONSTRAINT IF EXISTS tandem_session_user_id_tandem_user_id_fkey;

--> statement-breakpoint
ALTER TABLE "vault_secrets" DROP CONSTRAINT IF EXISTS tandem_vault_secrets_created_by_tandem_user_id_fkey;

--> statement-breakpoint
ALTER TABLE "task_activity" DROP CONSTRAINT IF EXISTS tandem_task_activity_author_id_tandem_user_id_fkey;

--> statement-breakpoint
ALTER TABLE "task_assignments" DROP CONSTRAINT IF EXISTS tandem_task_assignments_employee_id_tandem_user_id_fkey;

--> statement-breakpoint
ALTER TABLE "task_assignments" DROP CONSTRAINT IF EXISTS tandem_task_assignments_actor_id_tandem_user_id_fkey;

--> statement-breakpoint
ALTER TABLE "task_obligations" DROP CONSTRAINT IF EXISTS tandem_task_obligations_employee_id_tandem_user_id_fkey;

--> statement-breakpoint
ALTER TABLE "task_obligations" DROP CONSTRAINT IF EXISTS tandem_task_obligations_resolved_by_tandem_user_id_fkey;

--> statement-breakpoint
ALTER TABLE "task_proposals" DROP CONSTRAINT IF EXISTS tandem_task_proposals_decided_by_tandem_user_id_fkey;

--> statement-breakpoint
ALTER TABLE "task_reviews" DROP CONSTRAINT IF EXISTS tandem_task_reviews_reviewer_id_tandem_user_id_fkey;

--> statement-breakpoint
ALTER TABLE "task_runs" DROP CONSTRAINT IF EXISTS tandem_task_runs_employee_id_tandem_user_id_fkey;

--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS tandem_tasks_assignee_id_tandem_user_id_fkey;

--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS tandem_tasks_created_by_tandem_user_id_fkey;

--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS tandem_tasks_owner_id_tandem_user_id_fkey;

--> statement-breakpoint
-- one-time DML: remap legacy better-auth nanoid ids to real uuids before the
-- type change (pattern-guarded: only touches rows that are NOT uuid-parseable,
-- so re-running on a clean database is a no-op)
DO $$
DECLARE r record; newid text;
BEGIN
  FOR r IN SELECT id FROM "user" WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' LOOP
    newid := gen_random_uuid()::text;
    UPDATE account SET user_id = newid WHERE user_id = r.id;
    UPDATE ai_employees SET user_id = newid WHERE user_id = r.id;
    UPDATE apikey SET reference_id = newid WHERE reference_id = r.id;
    UPDATE employee_supervisors SET employee_id = newid WHERE employee_id = r.id;
    UPDATE employee_supervisors SET supervisor_id = newid WHERE supervisor_id = r.id;
    UPDATE session SET user_id = newid WHERE user_id = r.id;
    UPDATE vault_secrets SET created_by = newid WHERE created_by = r.id;
    UPDATE task_activity SET author_id = newid WHERE author_id = r.id;
    UPDATE task_assignments SET employee_id = newid WHERE employee_id = r.id;
    UPDATE task_assignments SET actor_id = newid WHERE actor_id = r.id;
    UPDATE task_obligations SET employee_id = newid WHERE employee_id = r.id;
    UPDATE task_obligations SET resolved_by = newid WHERE resolved_by = r.id;
    UPDATE task_proposals SET decided_by = newid WHERE decided_by = r.id;
    UPDATE task_reviews SET reviewer_id = newid WHERE reviewer_id = r.id;
    UPDATE task_runs SET employee_id = newid WHERE employee_id = r.id;
    UPDATE tasks SET assignee_id = newid WHERE assignee_id = r.id;
    UPDATE tasks SET created_by = newid WHERE created_by = r.id;
    UPDATE tasks SET owner_id = newid WHERE owner_id = r.id;
    UPDATE "user" SET id = newid WHERE id = r.id;
  END LOOP;
  -- auth tables' OWN legacy ids (no inbound FKs reference them)
  UPDATE session SET id = gen_random_uuid()::text WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  UPDATE account SET id = gen_random_uuid()::text WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  UPDATE apikey SET id = gen_random_uuid()::text WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  UPDATE verification SET id = gen_random_uuid()::text WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
END $$;

--> statement-breakpoint
ALTER TABLE "ai_employees" ALTER COLUMN "user_id" SET DATA TYPE uuid USING "user_id"::uuid;

--> statement-breakpoint
-- composite PK (employee_id, supervisor_id): both members must switch type in
-- ONE statement or the PK index rebuild compares text against uuid
ALTER TABLE "employee_supervisors" ALTER COLUMN "employee_id" SET DATA TYPE uuid USING "employee_id"::uuid, ALTER COLUMN "supervisor_id" SET DATA TYPE uuid USING "supervisor_id"::uuid;
ALTER TABLE "task_activity" ALTER COLUMN "author_id" SET DATA TYPE uuid USING "author_id"::uuid;

--> statement-breakpoint
ALTER TABLE "task_assignments" ALTER COLUMN "employee_id" SET DATA TYPE uuid USING "employee_id"::uuid;

--> statement-breakpoint
ALTER TABLE "task_assignments" ALTER COLUMN "actor_id" SET DATA TYPE uuid USING "actor_id"::uuid;

--> statement-breakpoint
ALTER TABLE "task_obligations" ALTER COLUMN "employee_id" SET DATA TYPE uuid USING "employee_id"::uuid;

--> statement-breakpoint
ALTER TABLE "task_obligations" ALTER COLUMN "resolved_by" SET DATA TYPE uuid USING "resolved_by"::uuid;

--> statement-breakpoint
ALTER TABLE "task_proposals" ALTER COLUMN "decided_by" SET DATA TYPE uuid USING "decided_by"::uuid;

--> statement-breakpoint
ALTER TABLE "task_reviews" ALTER COLUMN "reviewer_id" SET DATA TYPE uuid USING "reviewer_id"::uuid;

--> statement-breakpoint
ALTER TABLE "task_runs" ALTER COLUMN "employee_id" SET DATA TYPE uuid USING "employee_id"::uuid;

--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "assignee_id" SET DATA TYPE uuid USING "assignee_id"::uuid;

--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "owner_id" SET DATA TYPE uuid USING "owner_id"::uuid;

--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "created_by" SET DATA TYPE uuid USING "created_by"::uuid;

--> statement-breakpoint
ALTER TABLE "vault_secrets" ALTER COLUMN "created_by" SET DATA TYPE uuid USING "created_by"::uuid;

--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "id" SET DATA TYPE uuid USING "id"::uuid;

--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "user_id" SET DATA TYPE uuid USING "user_id"::uuid;

--> statement-breakpoint
ALTER TABLE "apikey" ALTER COLUMN "id" SET DATA TYPE uuid USING "id"::uuid;

--> statement-breakpoint
ALTER TABLE "apikey" ALTER COLUMN "reference_id" SET DATA TYPE uuid USING "reference_id"::uuid;

--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "id" SET DATA TYPE uuid USING "id"::uuid;

--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "user_id" SET DATA TYPE uuid USING "user_id"::uuid;

--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "id" SET DATA TYPE uuid USING "id"::uuid;

--> statement-breakpoint
ALTER TABLE "verification" ALTER COLUMN "id" SET DATA TYPE uuid USING "id"::uuid;

--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT account_user_id_user_id_fk FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;

--> statement-breakpoint
ALTER TABLE "ai_employees" ADD CONSTRAINT ai_employees_user_id_user_id_fk FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;

--> statement-breakpoint
ALTER TABLE "apikey" ADD CONSTRAINT apikey_reference_id_user_id_fk FOREIGN KEY ("reference_id") REFERENCES "user"("id") ON DELETE CASCADE;

--> statement-breakpoint
ALTER TABLE "employee_supervisors" ADD CONSTRAINT employee_supervisors_employee_id_user_id_fk FOREIGN KEY ("employee_id") REFERENCES "user"("id") ON DELETE CASCADE;

--> statement-breakpoint
ALTER TABLE "employee_supervisors" ADD CONSTRAINT employee_supervisors_supervisor_id_user_id_fk FOREIGN KEY ("supervisor_id") REFERENCES "user"("id") ON DELETE CASCADE;

--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT session_user_id_user_id_fk FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;

--> statement-breakpoint
ALTER TABLE "vault_secrets" ADD CONSTRAINT vault_secrets_created_by_user_id_fk FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE CASCADE;

--> statement-breakpoint
ALTER TABLE "task_activity" ADD CONSTRAINT task_activity_author_id_user_id_fk FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE "task_assignments" ADD CONSTRAINT task_assignments_employee_id_user_id_fk FOREIGN KEY ("employee_id") REFERENCES "user"("id") ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE "task_assignments" ADD CONSTRAINT task_assignments_actor_id_user_id_fk FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE "task_obligations" ADD CONSTRAINT task_obligations_employee_id_user_id_fk FOREIGN KEY ("employee_id") REFERENCES "user"("id") ON DELETE CASCADE;

--> statement-breakpoint
ALTER TABLE "task_obligations" ADD CONSTRAINT task_obligations_resolved_by_user_id_fk FOREIGN KEY ("resolved_by") REFERENCES "user"("id") ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE "task_proposals" ADD CONSTRAINT task_proposals_decided_by_user_id_fk FOREIGN KEY ("decided_by") REFERENCES "user"("id") ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE "task_reviews" ADD CONSTRAINT task_reviews_reviewer_id_user_id_fk FOREIGN KEY ("reviewer_id") REFERENCES "user"("id") ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT task_runs_employee_id_user_id_fk FOREIGN KEY ("employee_id") REFERENCES "user"("id") ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT tasks_assignee_id_user_id_fk FOREIGN KEY ("assignee_id") REFERENCES "user"("id") ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT tasks_created_by_user_id_fk FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL;

--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT tasks_owner_id_user_id_fk FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE SET NULL;
