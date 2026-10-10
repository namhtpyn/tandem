CREATE TYPE "tandem_employee_kind" AS ENUM('human', 'ai');--> statement-breakpoint
CREATE TABLE "tandem_ai_employees" (
	"employee_id" text PRIMARY KEY,
	"environment_id" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tandem_apikey" (
	"id" text PRIMARY KEY,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text NOT NULL,
	"start" text,
	"prefix" text,
	"key" text NOT NULL,
	"reference_id" text NOT NULL,
	"refill_interval" text,
	"refill_amount" text,
	"last_refill_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"rate_limit_enabled" boolean,
	"rate_limit_time_window" text,
	"rate_limit_max" text,
	"request_count" text,
	"remaining" text,
	"last_request" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"permissions" text,
	"metadata" text,
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
CREATE TABLE "tandem_employees" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL UNIQUE,
	"kind" "tandem_employee_kind" NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "tandem_apikey_reference_id_idx" ON "tandem_apikey" ("reference_id");--> statement-breakpoint
CREATE INDEX "tandem_employee_supervisors_supervisor_idx" ON "tandem_employee_supervisors" ("supervisor_id");--> statement-breakpoint
ALTER TABLE "tandem_ai_employees" ADD CONSTRAINT "tandem_ai_employees_employee_id_tandem_employees_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "tandem_employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_ai_employees" ADD CONSTRAINT "tandem_ai_employees_environment_id_tandem_environments_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "tandem_environments"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tandem_apikey" ADD CONSTRAINT "tandem_apikey_reference_id_tandem_user_id_fkey" FOREIGN KEY ("reference_id") REFERENCES "tandem_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_employee_supervisors" ADD CONSTRAINT "tandem_employee_supervisors_aWDitLooJc7l_fkey" FOREIGN KEY ("employee_id") REFERENCES "tandem_employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_employee_supervisors" ADD CONSTRAINT "tandem_employee_supervisors_Ub2loIR30PZL_fkey" FOREIGN KEY ("supervisor_id") REFERENCES "tandem_employees"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_employees" ADD CONSTRAINT "tandem_employees_user_id_tandem_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "tandem_user"("id") ON DELETE CASCADE;