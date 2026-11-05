ALTER TABLE "mcp_servers" ADD COLUMN "transport" text DEFAULT 'http' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "command" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "args" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "credential_env_var" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ALTER COLUMN "url" DROP NOT NULL;