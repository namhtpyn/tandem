CREATE TABLE "tandem_ai_employees" (
	"user_id" text PRIMARY KEY,
	"environment_id" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"executable" text NOT NULL,
	"provider_id" text,
	"model" text,
	"api_key_secret_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tandem_employee_supervisors" (
	"employee_id" text,
	"supervisor_id" text,
	CONSTRAINT "tandem_employee_supervisors_pkey" PRIMARY KEY("employee_id","supervisor_id"),
	CONSTRAINT "no_self_supervision" CHECK ("supervisor_id" <> "employee_id")
);
--> statement-breakpoint
CREATE TABLE "tandem_employee_titles" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tandem_environments" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL UNIQUE,
	"host" text NOT NULL,
	"port" text DEFAULT '22' NOT NULL,
	"username" text NOT NULL,
	"secret_id" text,
	"secret_usage" text DEFAULT 'ssh-key' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tandem_model_providers" (
	"id" text PRIMARY KEY,
	"label" text NOT NULL,
	"base_url" text NOT NULL,
	"endpoints" jsonb DEFAULT '["OPENAI-COMPLETIONS"]' NOT NULL,
	"extra_headers" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tandem_projects" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"parent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tandem_settings" (
	"key" text PRIMARY KEY,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tandem_task_activity" (
	"id" text PRIMARY KEY,
	"task_id" text NOT NULL,
	"kind" text NOT NULL,
	"author_id" text,
	"body" text DEFAULT '' NOT NULL,
	"meta" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tandem_task_assignments" (
	"id" text PRIMARY KEY,
	"task_id" text NOT NULL,
	"employee_id" text,
	"reason" text DEFAULT '' NOT NULL,
	"actor_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tandem_task_attachments" (
	"id" text PRIMARY KEY,
	"task_id" text NOT NULL,
	"run_id" text,
	"kind" text DEFAULT 'input' NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tandem_task_obligations" (
	"id" text PRIMARY KEY,
	"task_id" text NOT NULL,
	"employee_id" text,
	"role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text
);
--> statement-breakpoint
CREATE TABLE "tandem_task_proposals" (
	"id" text PRIMARY KEY,
	"task_id" text NOT NULL,
	"run_id" text,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"decision_note" text DEFAULT '' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tandem_task_reviews" (
	"id" text PRIMARY KEY,
	"task_id" text NOT NULL,
	"reviewer_id" text,
	"round" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tandem_task_runs" (
	"id" text PRIMARY KEY,
	"task_id" text NOT NULL,
	"employee_id" text,
	"session_id" text,
	"environment_id" text,
	"status" text DEFAULT 'running' NOT NULL,
	"exit_code" integer,
	"output" text DEFAULT '' NOT NULL,
	"prompt" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tandem_task_statuses" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"color" text DEFAULT 'neutral' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"category" text DEFAULT 'backlog' NOT NULL,
	"next_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tandem_tasks" (
	"id" text PRIMARY KEY,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"project_id" text,
	"assignee_id" text,
	"owner_id" text,
	"reviewers" text[] DEFAULT '{}'::text[] NOT NULL,
	"question_chain" text[] DEFAULT '{}'::text[] NOT NULL,
	"dispatch_after" timestamp with time zone,
	"fail_streak" integer DEFAULT 0 NOT NULL,
	"parent_task_id" text,
	"acp_session_id" text,
	"pre_block_status" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tandem_vault_audit" (
	"id" text PRIMARY KEY,
	"secret_id" text,
	"secret_name" text NOT NULL,
	"action" text NOT NULL,
	"actor_id" text DEFAULT 'system' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tandem_vault_folders" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tandem_vault_secrets" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"folder_id" text,
	"ciphertext" text NOT NULL,
	"last_four" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tandem_account" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tandem_apikey" (
	"id" text PRIMARY KEY,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"reference_id" text NOT NULL,
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
CREATE TABLE "tandem_session" (
	"id" text PRIMARY KEY,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tandem_user" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"role" text DEFAULT 'viewer',
	"title" text DEFAULT ''
);
--> statement-breakpoint
CREATE TABLE "tandem_verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "tandem_employee_supervisors_supervisor_idx" ON "tandem_employee_supervisors" ("supervisor_id");--> statement-breakpoint
CREATE INDEX "tandem_projects_parent_idx" ON "tandem_projects" ("parent_id");--> statement-breakpoint
CREATE INDEX "tandem_task_activity_task_idx" ON "tandem_task_activity" ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "tandem_task_assignments_task_idx" ON "tandem_task_assignments" ("task_id","started_at");--> statement-breakpoint
CREATE INDEX "tandem_task_attachments_task_idx" ON "tandem_task_attachments" ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "tandem_task_obligations_task_idx" ON "tandem_task_obligations" ("task_id","role","status");--> statement-breakpoint
CREATE INDEX "tandem_task_obligations_employee_idx" ON "tandem_task_obligations" ("employee_id","status");--> statement-breakpoint
CREATE INDEX "tandem_task_proposals_task_idx" ON "tandem_task_proposals" ("task_id","status");--> statement-breakpoint
CREATE INDEX "tandem_task_reviews_task_idx" ON "tandem_task_reviews" ("task_id","round");--> statement-breakpoint
CREATE INDEX "tandem_task_runs_task_idx" ON "tandem_task_runs" ("task_id","started_at");--> statement-breakpoint
CREATE INDEX "tandem_tasks_assignee_idx" ON "tandem_tasks" ("assignee_id");--> statement-breakpoint
CREATE INDEX "tandem_tasks_project_idx" ON "tandem_tasks" ("project_id");--> statement-breakpoint
CREATE INDEX "tandem_tasks_status_idx" ON "tandem_tasks" ("status");--> statement-breakpoint
CREATE INDEX "tandem_vault_audit_secret_idx" ON "tandem_vault_audit" ("secret_id");--> statement-breakpoint
CREATE INDEX "tandem_vault_audit_at_idx" ON "tandem_vault_audit" ("at");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "tandem_account" ("user_id");--> statement-breakpoint
CREATE INDEX "apikey_configId_idx" ON "tandem_apikey" ("config_id");--> statement-breakpoint
CREATE INDEX "apikey_referenceId_idx" ON "tandem_apikey" ("reference_id");--> statement-breakpoint
CREATE INDEX "apikey_key_idx" ON "tandem_apikey" ("key");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "tandem_session" ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "tandem_verification" ("identifier");--> statement-breakpoint
ALTER TABLE "tandem_ai_employees" ADD CONSTRAINT "tandem_ai_employees_user_id_tandem_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "tandem_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_ai_employees" ADD CONSTRAINT "tandem_ai_employees_environment_id_tandem_environments_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "tandem_environments"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tandem_ai_employees" ADD CONSTRAINT "tandem_ai_employees_provider_id_tandem_model_providers_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "tandem_model_providers"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tandem_ai_employees" ADD CONSTRAINT "tandem_ai_employees_CYYLotA3fNSf_fkey" FOREIGN KEY ("api_key_secret_id") REFERENCES "tandem_vault_secrets"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tandem_employee_supervisors" ADD CONSTRAINT "tandem_employee_supervisors_employee_id_tandem_user_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "tandem_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_employee_supervisors" ADD CONSTRAINT "tandem_employee_supervisors_supervisor_id_tandem_user_id_fkey" FOREIGN KEY ("supervisor_id") REFERENCES "tandem_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_environments" ADD CONSTRAINT "tandem_environments_secret_id_tandem_vault_secrets_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "tandem_vault_secrets"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tandem_projects" ADD CONSTRAINT "tandem_projects_parent_id_tandem_projects_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "tandem_projects"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tandem_task_activity" ADD CONSTRAINT "tandem_task_activity_task_id_tandem_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tandem_tasks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_task_activity" ADD CONSTRAINT "tandem_task_activity_author_id_tandem_user_id_fkey" FOREIGN KEY ("author_id") REFERENCES "tandem_user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tandem_task_assignments" ADD CONSTRAINT "tandem_task_assignments_task_id_tandem_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tandem_tasks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_task_assignments" ADD CONSTRAINT "tandem_task_assignments_employee_id_tandem_user_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "tandem_user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tandem_task_assignments" ADD CONSTRAINT "tandem_task_assignments_actor_id_tandem_user_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "tandem_user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tandem_task_attachments" ADD CONSTRAINT "tandem_task_attachments_task_id_tandem_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tandem_tasks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_task_obligations" ADD CONSTRAINT "tandem_task_obligations_task_id_tandem_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tandem_tasks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_task_obligations" ADD CONSTRAINT "tandem_task_obligations_employee_id_tandem_user_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "tandem_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_task_obligations" ADD CONSTRAINT "tandem_task_obligations_resolved_by_tandem_user_id_fkey" FOREIGN KEY ("resolved_by") REFERENCES "tandem_user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tandem_task_proposals" ADD CONSTRAINT "tandem_task_proposals_task_id_tandem_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tandem_tasks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_task_proposals" ADD CONSTRAINT "tandem_task_proposals_run_id_tandem_task_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "tandem_task_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_task_proposals" ADD CONSTRAINT "tandem_task_proposals_decided_by_tandem_user_id_fkey" FOREIGN KEY ("decided_by") REFERENCES "tandem_user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tandem_task_reviews" ADD CONSTRAINT "tandem_task_reviews_task_id_tandem_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tandem_tasks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_task_reviews" ADD CONSTRAINT "tandem_task_reviews_reviewer_id_tandem_user_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "tandem_user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tandem_task_runs" ADD CONSTRAINT "tandem_task_runs_task_id_tandem_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tandem_tasks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_task_runs" ADD CONSTRAINT "tandem_task_runs_employee_id_tandem_user_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "tandem_user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tandem_tasks" ADD CONSTRAINT "tandem_tasks_project_id_tandem_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "tandem_projects"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tandem_tasks" ADD CONSTRAINT "tandem_tasks_assignee_id_tandem_user_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "tandem_user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tandem_tasks" ADD CONSTRAINT "tandem_tasks_owner_id_tandem_user_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "tandem_user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tandem_tasks" ADD CONSTRAINT "tandem_tasks_parent_task_id_tandem_tasks_id_fkey" FOREIGN KEY ("parent_task_id") REFERENCES "tandem_tasks"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tandem_tasks" ADD CONSTRAINT "tandem_tasks_created_by_tandem_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "tandem_user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tandem_vault_audit" ADD CONSTRAINT "tandem_vault_audit_secret_id_tandem_vault_secrets_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "tandem_vault_secrets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_vault_secrets" ADD CONSTRAINT "tandem_vault_secrets_folder_id_tandem_vault_folders_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "tandem_vault_folders"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tandem_vault_secrets" ADD CONSTRAINT "tandem_vault_secrets_created_by_tandem_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "tandem_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_account" ADD CONSTRAINT "tandem_account_user_id_tandem_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "tandem_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_apikey" ADD CONSTRAINT "tandem_apikey_reference_id_tandem_user_id_fkey" FOREIGN KEY ("reference_id") REFERENCES "tandem_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_session" ADD CONSTRAINT "tandem_session_user_id_tandem_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "tandem_user"("id") ON DELETE CASCADE;
--> statement-breakpoint
-- Bootstrap data (drizzle-kit is DDL-only — this is the ONE-TIME baseline seed,
-- matching prod exactly as of 2026-10-16; idempotent ON CONFLICT DO NOTHING).
-- Future schema changes are drizzle-kit generated only; future seed tweaks belong
-- in app boot code, never here.
INSERT INTO "tandem_task_statuses" ("id", "name", "color", "position", "category", "next_ids") VALUES
	('todo', 'To do', 'neutral', 0, 'ready', ARRAY['doing','cancelled']::text[]),
	('doing', 'Doing', 'warning', 1, 'working', ARRAY['todo','waiting-answer','in-review','done','blocked']::text[]),
	('done', 'Done', 'success', 2, 'done', ARRAY['doing']::text[]),
	('waiting-answer', 'Waiting answer', 'warning', 3, 'waiting_answer', ARRAY['doing']::text[]),
	('in-review', 'In review', 'info', 4, 'in_review', ARRAY['doing','done']::text[]),
	('blocked', 'Blocked', 'error', 5, 'paused', ARRAY['todo','blocked']::text[]),
	('cancelled', 'Cancelled', 'neutral', 6, 'cancelled', ARRAY[]::text[])
ON CONFLICT ("id") DO NOTHING;
