-- Blocked: no self-transition; Blocked -> To do + Cancelled
UPDATE "task_statuses"
SET "next_ids" = (SELECT ARRAY(SELECT DISTINCT unnest("next_ids" || ARRAY['01a14743-43f5-759d-a00e-b0f2a5a04f4c']) EXCEPT SELECT '01a14743-43f5-759d-a00e-ada27e46c2f8'))
WHERE "id" = '01a14743-43f5-759d-a00e-ada27e46c2f8';
