-- Rename api_styles -> endpoints and re-root baseUrls to the host root (before /v1).
ALTER TABLE "tandem_model_providers" RENAME COLUMN "api_styles" TO "endpoints";

-- Base URL LAW: store only the host root; adapters append /v1/... paths.
UPDATE "tandem_model_providers"
SET "base_url" = regexp_replace(rtrim("base_url", '/'), '/v1(/.*)?$', '')
WHERE "base_url" ~ '/v1(/.*)?$';

-- At most one /v1/models endpoint per provider (keep the last listed).
UPDATE "tandem_model_providers" p
SET "endpoints" = sub.keep
FROM (
  SELECT id, coalesce(jsonb_agg(elem ORDER BY rn), '[]'::jsonb) AS keep
  FROM (
    SELECT p2.id, elem, rn,
           rn = (
             SELECT max(rn3)
             FROM jsonb_array_elements(p2."endpoints") WITH ORDINALITY AS t3(e2, rn3)
             WHERE t3.e2 #>> '{}' IN ('OPENAI-MODELS', 'ANTHROPIC-MODELS', 'TYPESAFE-MODELS')
           ) AS is_kept_models
    FROM "tandem_model_providers" p2,
         jsonb_array_elements(p2."endpoints") WITH ORDINALITY AS t(elem, rn)
  ) ranked
  WHERE NOT (is_kept_models = false AND elem #>> '{}' IN ('OPENAI-MODELS', 'ANTHROPIC-MODELS', 'TYPESAFE-MODELS'))
  GROUP BY id
) sub
WHERE p.id = sub.id
  AND (
    SELECT count(*) FROM jsonb_array_elements_text(p."endpoints")
    WHERE value IN ('OPENAI-MODELS', 'ANTHROPIC-MODELS', 'TYPESAFE-MODELS')
  ) > 1;
