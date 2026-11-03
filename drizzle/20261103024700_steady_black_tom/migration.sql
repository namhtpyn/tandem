CREATE TABLE "mcp_server_bindings" (
	"id" text PRIMARY KEY,
	"employee_id" uuid NOT NULL,
	"server_id" text NOT NULL,
	"secret_id" text,
	"last_probe_ok" boolean,
	"last_probe_detail" text,
	"last_probe_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL UNIQUE,
	"url" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_server_bindings_employee_server_uniq" ON "mcp_server_bindings" ("employee_id","server_id");--> statement-breakpoint
CREATE INDEX "mcp_server_bindings_server_idx" ON "mcp_server_bindings" ("server_id");--> statement-breakpoint
ALTER TABLE "mcp_server_bindings" ADD CONSTRAINT "mcp_server_bindings_employee_id_user_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mcp_server_bindings" ADD CONSTRAINT "mcp_server_bindings_server_id_mcp_servers_id_fkey" FOREIGN KEY ("server_id") REFERENCES "mcp_servers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mcp_server_bindings" ADD CONSTRAINT "mcp_server_bindings_secret_id_vault_secrets_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "vault_secrets"("id") ON DELETE SET NULL;