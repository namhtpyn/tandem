-- abandoned == cancelled: one terminal, no fake distinction (2026-10-15)
DELETE FROM "tandem_task_statuses" WHERE "id" = 'abandoned';
UPDATE "tandem_task_statuses" SET "next_ids" = array_remove("next_ids", 'abandoned') WHERE "next_ids" @> '{abandoned}';
