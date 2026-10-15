-- historical fix: pre-2.27.2 dispatch notes were created a few ms AFTER their run
-- row, so the timeline showed them after the result. Re-anchor them 1ms before.
UPDATE tandem_task_activity a
SET created_at = r.started_at - interval '1 millisecond'
FROM tandem_task_runs r
WHERE a.meta->>'runId' = r.id
  AND a.meta->>'dispatched' = 'true'
  AND a.created_at > r.started_at;
