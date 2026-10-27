CREATE TABLE "account" (
	"id" uuid PRIMARY KEY,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_employees" (
	"user_id" uuid PRIMARY KEY,
	"environment_id" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"executable" text NOT NULL,
	"provider_id" text,
	"model" text,
	"api_key_secret_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apikey" (
	"id" uuid PRIMARY KEY,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"reference_id" uuid NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp with time zone,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer DEFAULT 86400000,
	"rate_limit_max" integer DEFAULT 10,
	"request_count" integer DEFAULT 0,
	"remaining" integer,
	"last_request" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "employee_supervisors" (
	"employee_id" uuid,
	"supervisor_id" uuid,
	CONSTRAINT "employee_supervisors_pkey" PRIMARY KEY("employee_id","supervisor_id"),
	CONSTRAINT "no_self_supervision" CHECK ("supervisor_id" <> "employee_id")
);
--> statement-breakpoint
CREATE TABLE "employee_titles" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL UNIQUE,
	"host" text NOT NULL,
	"port" text DEFAULT '22' NOT NULL,
	"username" text NOT NULL,
	"secret_id" text,
	"secret_usage" text DEFAULT 'SSH_KEY' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_providers" (
	"id" text PRIMARY KEY,
	"label" text NOT NULL,
	"base_url" text NOT NULL,
	"endpoints" jsonb DEFAULT '["OPENAI-COMPLETIONS"]' NOT NULL,
	"extra_headers" text,
	"notes" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"parent_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_activity" (
	"id" text PRIMARY KEY,
	"task_id" text NOT NULL,
	"kind" text NOT NULL,
	"author_id" uuid,
	"body" text DEFAULT '' NOT NULL,
	"meta" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_assignments" (
	"id" text PRIMARY KEY,
	"task_id" text NOT NULL,
	"employee_id" uuid,
	"reason" text DEFAULT '' NOT NULL,
	"actor_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_attachments" (
	"id" text PRIMARY KEY,
	"task_id" text NOT NULL,
	"run_id" text,
	"kind" text DEFAULT 'input' NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_message_activities" (
	"message_id" text PRIMARY KEY,
	"payload" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_message_runs" (
	"message_id" text PRIMARY KEY,
	"run_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_messages" (
	"id" text PRIMARY KEY,
	"task_id" text NOT NULL,
	"author_id" uuid,
	"body" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_obligations" (
	"id" text PRIMARY KEY,
	"task_id" text NOT NULL,
	"employee_id" uuid,
	"role" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid
);
--> statement-breakpoint
CREATE TABLE "task_proposals" (
	"id" text PRIMARY KEY,
	"task_id" text NOT NULL,
	"run_id" text,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'PROPOSED' NOT NULL,
	"decision_note" text DEFAULT '' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_reviews" (
	"id" text PRIMARY KEY,
	"task_id" text NOT NULL,
	"reviewer_id" uuid,
	"round" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"note" text,
	"source" text,
	"created_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_runs" (
	"id" text PRIMARY KEY,
	"message_id" text NOT NULL,
	"employee_id" uuid,
	"session_id" text,
	"environment_id" text,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"exit_code" integer,
	"output" text DEFAULT '' NOT NULL,
	"prompt" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_statuses" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"color" text DEFAULT 'neutral' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"category" text DEFAULT 'backlog' NOT NULL,
	"next_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT '01a14743-43f4-7053-a698-5b4ef36ed046' NOT NULL,
	"project_id" text,
	"assignee_id" uuid,
	"owner_id" uuid,
	"reviewers" text[] DEFAULT '{}'::text[] NOT NULL,
	"question_chain" text[] DEFAULT '{}'::text[] NOT NULL,
	"dispatch_after" timestamp with time zone,
	"fail_streak" integer DEFAULT 0 NOT NULL,
	"parent_task_id" text,
	"pre_block_status" text,
	"created_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"role" text DEFAULT 'VIEWER',
	"title" text DEFAULT ''
);
--> statement-breakpoint
CREATE TABLE "vault_folders" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_secrets" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"folder_id" text,
	"ciphertext" text NOT NULL,
	"last_four" text DEFAULT '' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" ("user_id");--> statement-breakpoint
CREATE INDEX "apikey_configId_idx" ON "apikey" ("config_id");--> statement-breakpoint
CREATE INDEX "apikey_referenceId_idx" ON "apikey" ("reference_id");--> statement-breakpoint
CREATE INDEX "apikey_key_idx" ON "apikey" ("key");--> statement-breakpoint
CREATE INDEX "employee_supervisors_supervisor_idx" ON "employee_supervisors" ("supervisor_id");--> statement-breakpoint
CREATE INDEX "projects_parent_idx" ON "projects" ("parent_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" ("user_id");--> statement-breakpoint
CREATE INDEX "task_activity_task_idx" ON "task_activity" ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_assignments_task_idx" ON "task_assignments" ("task_id","started_at");--> statement-breakpoint
CREATE INDEX "task_attachments_task_idx" ON "task_attachments" ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_messages_task_idx" ON "task_messages" ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_obligations_task_idx" ON "task_obligations" ("task_id","role","status");--> statement-breakpoint
CREATE INDEX "task_obligations_employee_idx" ON "task_obligations" ("employee_id","status");--> statement-breakpoint
CREATE INDEX "task_proposals_task_idx" ON "task_proposals" ("task_id","status");--> statement-breakpoint
CREATE INDEX "task_reviews_task_idx" ON "task_reviews" ("task_id","round");--> statement-breakpoint
CREATE INDEX "task_runs_message_idx" ON "task_runs" ("message_id","started_at");--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" ("assignee_id");--> statement-breakpoint
CREATE INDEX "tasks_project_idx" ON "tasks" ("project_id");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" ("status");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_employees" ADD CONSTRAINT "ai_employees_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_employees" ADD CONSTRAINT "ai_employees_environment_id_environments_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "ai_employees" ADD CONSTRAINT "ai_employees_provider_id_model_providers_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "model_providers"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ai_employees" ADD CONSTRAINT "ai_employees_api_key_secret_id_vault_secrets_id_fkey" FOREIGN KEY ("api_key_secret_id") REFERENCES "vault_secrets"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "apikey" ADD CONSTRAINT "apikey_reference_id_user_id_fkey" FOREIGN KEY ("reference_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "employee_supervisors" ADD CONSTRAINT "employee_supervisors_employee_id_user_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "employee_supervisors" ADD CONSTRAINT "employee_supervisors_supervisor_id_user_id_fkey" FOREIGN KEY ("supervisor_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_secret_id_vault_secrets_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "vault_secrets"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_parent_id_projects_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "projects"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_author_id_user_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_employee_id_user_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_actor_id_user_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_message_activities" ADD CONSTRAINT "task_message_activities_message_id_task_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "task_messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_message_runs" ADD CONSTRAINT "task_message_runs_message_id_task_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "task_messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_message_runs" ADD CONSTRAINT "task_message_runs_run_id_task_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "task_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_messages" ADD CONSTRAINT "task_messages_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_messages" ADD CONSTRAINT "task_messages_author_id_user_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "task_obligations" ADD CONSTRAINT "task_obligations_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_obligations" ADD CONSTRAINT "task_obligations_employee_id_user_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_obligations" ADD CONSTRAINT "task_obligations_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "task_proposals" ADD CONSTRAINT "task_proposals_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_proposals" ADD CONSTRAINT "task_proposals_run_id_task_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "task_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_proposals" ADD CONSTRAINT "task_proposals_decided_by_user_id_fkey" FOREIGN KEY ("decided_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "task_reviews" ADD CONSTRAINT "task_reviews_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_reviews" ADD CONSTRAINT "task_reviews_reviewer_id_user_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_message_id_task_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "task_messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_employee_id_user_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_user_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_id_user_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fkey" FOREIGN KEY ("parent_task_id") REFERENCES "tasks"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "vault_secrets" ADD CONSTRAINT "vault_secrets_folder_id_vault_folders_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "vault_folders"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "vault_secrets" ADD CONSTRAINT "vault_secrets_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE CASCADE;
--> statement-breakpoint
-- Bootstrap data (drizzle-kit is DDL-only — this is the ONE-TIME baseline seed,
-- matching prod exactly as of 2026-10-16; idempotent ON CONFLICT DO NOTHING).
INSERT INTO "task_statuses" ("id", "name", "color", "position", "category", "next_ids", "created_at", "updated_at") VALUES
	('01a14743-43f4-7053-a698-5b4ef36ed046', 'To do', 'neutral', 0, 'ready', ARRAY['01a14743-43f5-759d-a00e-9ccda502cc88','01a14743-43f5-759d-a00e-b0f2a5a04f4c']::text[], now(), now()),
	('01a14743-43f5-759d-a00e-9ccda502cc88', 'Doing', 'warning', 1, 'working', ARRAY['01a14743-43f4-7053-a698-5b4ef36ed046','01a14743-43f5-759d-a00e-a424b478f2fa','01a14743-43f5-759d-a00e-a90831248ea5','01a14743-43f5-759d-a00e-a20a36faa315','01a14743-43f5-759d-a00e-ada27e46c2f8']::text[], now(), now()),
	('01a14743-43f5-759d-a00e-a20a36faa315', 'Done', 'success', 2, 'done', ARRAY['01a14743-43f5-759d-a00e-9ccda502cc88']::text[], now(), now()),
	('01a14743-43f5-759d-a00e-a424b478f2fa', 'Waiting answer', 'warning', 3, 'waiting_answer', ARRAY['01a14743-43f5-759d-a00e-9ccda502cc88']::text[], now(), now()),
	('01a14743-43f5-759d-a00e-a90831248ea5', 'In review', 'info', 4, 'in_review', ARRAY['01a14743-43f5-759d-a00e-9ccda502cc88','01a14743-43f5-759d-a00e-a20a36faa315']::text[], now(), now()),
	('01a14743-43f5-759d-a00e-ada27e46c2f8', 'Blocked', 'error', 5, 'paused', ARRAY['01a14743-43f4-7053-a698-5b4ef36ed046','01a14743-43f5-759d-a00e-b0f2a5a04f4c']::text[], now(), now()),
	('01a14743-43f5-759d-a00e-b0f2a5a04f4c', 'Cancelled', 'neutral', 6, 'cancelled', ARRAY[]::text[], now(), now())
ON CONFLICT ("id") DO NOTHING;
