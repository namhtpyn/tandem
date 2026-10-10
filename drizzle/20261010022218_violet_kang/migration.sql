CREATE TABLE "tandem_ai_employees" (
	"user_id" text PRIMARY KEY,
	"environment_id" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "tandem_employee_supervisors" (
	"employee_id" text,
	"supervisor_id" text,
	CONSTRAINT "tandem_employee_supervisors_pkey" PRIMARY KEY("employee_id","supervisor_id"),
	CONSTRAINT "no_self_supervision" CHECK ("supervisor_id" <> "employee_id")
);
--> statement-breakpoint
ALTER TABLE "tandem_user" ADD COLUMN "title" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "tandem_account" ALTER COLUMN "updated_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tandem_session" ALTER COLUMN "updated_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tandem_user" ALTER COLUMN "email_verified" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "tandem_user" ALTER COLUMN "role" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tandem_verification" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "tandem_verification" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tandem_verification" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "tandem_verification" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "tandem_account" ("user_id");--> statement-breakpoint
CREATE INDEX "apikey_configId_idx" ON "tandem_apikey" ("config_id");--> statement-breakpoint
CREATE INDEX "apikey_referenceId_idx" ON "tandem_apikey" ("reference_id");--> statement-breakpoint
CREATE INDEX "apikey_key_idx" ON "tandem_apikey" ("key");--> statement-breakpoint
CREATE INDEX "tandem_employee_supervisors_supervisor_idx" ON "tandem_employee_supervisors" ("supervisor_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "tandem_session" ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "tandem_verification" ("identifier");--> statement-breakpoint
ALTER TABLE "tandem_ai_employees" ADD CONSTRAINT "tandem_ai_employees_user_id_tandem_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "tandem_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_ai_employees" ADD CONSTRAINT "tandem_ai_employees_environment_id_tandem_environments_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "tandem_environments"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tandem_apikey" ADD CONSTRAINT "tandem_apikey_reference_id_tandem_user_id_fkey" FOREIGN KEY ("reference_id") REFERENCES "tandem_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_employee_supervisors" ADD CONSTRAINT "tandem_employee_supervisors_employee_id_tandem_user_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "tandem_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_employee_supervisors" ADD CONSTRAINT "tandem_employee_supervisors_supervisor_id_tandem_user_id_fkey" FOREIGN KEY ("supervisor_id") REFERENCES "tandem_user"("id") ON DELETE CASCADE;