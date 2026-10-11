DROP INDEX IF EXISTS "tandem_models_provider_idx";--> statement-breakpoint
ALTER TABLE "tandem_ai_employees" DROP CONSTRAINT IF EXISTS "tandem_ai_employees_model_id_tandem_models_id_fkey";--> statement-breakpoint
ALTER TABLE "tandem_ai_employees" RENAME COLUMN "model_id" TO "model";--> statement-breakpoint
DROP TABLE IF EXISTS "tandem_models";
