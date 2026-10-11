ALTER TABLE "tandem_model_providers" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'llm';
ALTER TABLE "tandem_model_providers" ADD COLUMN IF NOT EXISTS "key_secret_id" text;
-- Seed the Jev decision provider (idempotent)
INSERT INTO "tandem_model_providers" ("id", "label", "base_url", "api_style", "kind", "notes")
VALUES ('seed-jev', 'Jev (TypeSafe AI)', 'https://api.typesafe.ai/v1/systemone', 'openai', 'decision', 'System One typed-choice decision model for task assignment')
ON CONFLICT ("id") DO NOTHING;
-- Migrate legacy jevApiKeySecretId setting (if present) onto the provider row
UPDATE "tandem_model_providers"
SET "key_secret_id" = (SELECT "value" FROM "tandem_settings" WHERE "key" = 'jevApiKeySecretId'),
    "updated_at" = now()
WHERE "id" = 'seed-jev'
  AND "key_secret_id" IS NULL
  AND EXISTS (SELECT 1 FROM "tandem_settings" WHERE "key" = 'jevApiKeySecretId');
DELETE FROM "tandem_settings" WHERE "key" = 'jevApiKeySecretId';
