ALTER TABLE "tandem_vault_secrets" RENAME COLUMN "kind" TO "description";--> statement-breakpoint
ALTER TABLE "tandem_vault_secrets" DROP CONSTRAINT "tandem_vault_secrets_name_key";--> statement-breakpoint
ALTER TABLE "tandem_vault_secrets" ALTER COLUMN "description" SET DEFAULT '';