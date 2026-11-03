CREATE TABLE "mcp_oauth_states" (
	"id" text PRIMARY KEY,
	"binding_id" text NOT NULL,
	"code_verifier" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_tokens" (
	"id" text PRIMARY KEY,
	"binding_id" text NOT NULL UNIQUE,
	"access_enc" text NOT NULL,
	"refresh_enc" text,
	"expires_at" timestamp with time zone,
	"scope" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "auth_kind" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_authorize_url" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_token_url" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_revocation_url" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_scopes" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_client_secret_id" text;--> statement-breakpoint
ALTER TABLE "mcp_oauth_states" ADD CONSTRAINT "mcp_oauth_states_binding_id_mcp_server_bindings_id_fkey" FOREIGN KEY ("binding_id") REFERENCES "mcp_server_bindings"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mcp_oauth_tokens" ADD CONSTRAINT "mcp_oauth_tokens_binding_id_mcp_server_bindings_id_fkey" FOREIGN KEY ("binding_id") REFERENCES "mcp_server_bindings"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_oauth_client_secret_id_vault_secrets_id_fkey" FOREIGN KEY ("oauth_client_secret_id") REFERENCES "vault_secrets"("id") ON DELETE SET NULL;