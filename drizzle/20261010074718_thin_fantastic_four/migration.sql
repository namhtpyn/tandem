CREATE TABLE "tandem_vault_audit" (
	"id" text PRIMARY KEY,
	"secret_id" text,
	"secret_name" text NOT NULL,
	"action" text NOT NULL,
	"actor_id" text DEFAULT 'system' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tandem_vault_secrets" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL UNIQUE,
	"kind" text DEFAULT 'generic' NOT NULL,
	"ciphertext" text NOT NULL,
	"last_four" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "tandem_vault_audit_secret_idx" ON "tandem_vault_audit" ("secret_id");--> statement-breakpoint
CREATE INDEX "tandem_vault_audit_at_idx" ON "tandem_vault_audit" ("at");--> statement-breakpoint
ALTER TABLE "tandem_vault_audit" ADD CONSTRAINT "tandem_vault_audit_secret_id_tandem_vault_secrets_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "tandem_vault_secrets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tandem_vault_secrets" ADD CONSTRAINT "tandem_vault_secrets_created_by_tandem_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "tandem_user"("id") ON DELETE CASCADE;