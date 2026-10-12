-- Prune removed api styles (OPENAI-AGENTS, ANTHROPIC-SKILLS) from stored sets.
-- OPENAI-AGENTS rides on Responses; ANTHROPIC-SKILLS rides on Messages.
UPDATE "tandem_model_providers"
SET "api_styles" = (
  SELECT coalesce(jsonb_agg(DISTINCT s), '[]'::jsonb)
  FROM jsonb_array_elements_text("api_styles") AS s
  WHERE s NOT IN ('OPENAI-AGENTS', 'ANTHROPIC-SKILLS')
)
WHERE "api_styles" @> '["OPENAI-AGENTS"]' OR "api_styles" @> '["ANTHROPIC-SKILLS"]';

-- Provider rows never carry keys anymore (drop entirely): decision calls pass a
-- vault secret id per call, exactly like the /models autocomplete probe.
ALTER TABLE "tandem_model_providers" DROP COLUMN IF EXISTS "key_secret_id";
