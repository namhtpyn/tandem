-- apiStyle (single) + kind -> apiStyles (set, shared/api-styles.ts source of truth)
ALTER TABLE "tandem_model_providers" ADD COLUMN IF NOT EXISTS "api_styles" jsonb NOT NULL DEFAULT '["OPENAI-COMPLETIONS"]'::jsonb;

UPDATE "tandem_model_providers" SET "api_styles" = CASE
  WHEN "kind" = 'decision' AND "id" = 'seed-jev' THEN '["TYPESAFE-SYSTEMONE"]'::jsonb
  WHEN "kind" = 'decision' THEN '["TYPESAFE-SYSTEMONE"]'::jsonb
  WHEN "api_style" = 'anthropic' THEN '["ANTHROPIC-MESSAGES"]'::jsonb
  ELSE '["OPENAI-COMPLETIONS"]'::jsonb
END;

ALTER TABLE "tandem_model_providers" DROP COLUMN IF EXISTS "api_style";
ALTER TABLE "tandem_model_providers" DROP COLUMN IF EXISTS "kind";
