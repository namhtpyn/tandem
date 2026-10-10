CREATE TABLE "tandem_model_providers" (
	"id" text PRIMARY KEY,
	"label" text NOT NULL,
	"base_url" text NOT NULL,
	"api_style" text DEFAULT 'openai' NOT NULL,
	"extra_headers" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tandem_models" (
	"id" text PRIMARY KEY,
	"provider_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tandem_ai_employees" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "tandem_ai_employees" ADD COLUMN "model_id" text;--> statement-breakpoint
ALTER TABLE "tandem_ai_employees" ADD COLUMN "api_key_secret_id" text;--> statement-breakpoint
CREATE INDEX "tandem_models_provider_idx" ON "tandem_models" ("provider_id");--> statement-breakpoint
ALTER TABLE "tandem_ai_employees" ADD CONSTRAINT "tandem_ai_employees_provider_id_tandem_model_providers_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "tandem_model_providers"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tandem_ai_employees" ADD CONSTRAINT "tandem_ai_employees_model_id_tandem_models_id_fkey" FOREIGN KEY ("model_id") REFERENCES "tandem_models"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tandem_ai_employees" ADD CONSTRAINT "tandem_ai_employees_CYYLotA3fNSf_fkey" FOREIGN KEY ("api_key_secret_id") REFERENCES "tandem_vault_secrets"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tandem_models" ADD CONSTRAINT "tandem_models_provider_id_tandem_model_providers_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "tandem_model_providers"("id") ON DELETE CASCADE;
-- Seed providers + models (fixed ids; idempotent)
INSERT INTO "tandem_model_providers" ("id","label","base_url","api_style","notes") VALUES
  ('seed-openai','OpenAI','https://api.openai.com/v1','openai','Platform keys at platform.openai.com'),
  ('seed-anthropic','Anthropic','https://api.anthropic.com','anthropic','Keys at console.anthropic.com'),
  ('seed-openrouter','OpenRouter','https://openrouter.ai/api/v1','openai','Keys at openrouter.ai/keys')
ON CONFLICT ("id") DO NOTHING;
INSERT INTO "tandem_models" ("id","provider_id","name") VALUES
  ('seed-model-gpt52','seed-openai','gpt-5.2'),
  ('seed-model-gpt52-mini','seed-openai','gpt-5.2-mini'),
  ('seed-model-sonnet45','seed-anthropic','claude-sonnet-4-5'),
  ('seed-model-opus45','seed-anthropic','claude-opus-4-5'),
  ('seed-model-or-auto','seed-openrouter','openrouter/auto'),
  ('seed-model-or-gpt','seed-openrouter','openrouter/gpt-5.2')
ON CONFLICT ("id") DO NOTHING;
