// round-result law (task_activity retirement 2026-10-30): the review round
// carries the submitted result it judges — openReviewRound writes
// task_reviews.result_body, and the re-arm fallback (dispatchAiReviewTurns
// without a resultBody argument) reads it back from the CURRENT round. SQL
// shape pinned on the driver-less mock db; behavior lives in e2e.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { nonNull } from '#shared/utils/non-null';

import { mockDb, taskReviews } from './helpers/mock-db';

describe('round result body (task_activity retirement)', () => {
  it('the round-open insert carries result_body on task_reviews', () => {
    const db = mockDb();
    const { sql, params } = db
      .insert(taskReviews)
      .values({
        id: 'r-1',
        taskId: 't-1',
        reviewerId: 'u-1',
        round: 2,
        status: 'PENDING',
        resultBody: 'the submitted result',
      })
      .toSQL();
    expect(sql).toContain('insert into "task_reviews"');
    expect(sql).toContain('"result_body"');
    expect(params).toContain('the submitted result');
  });

  it('the re-arm read filters the CURRENT round and selects result_body only', () => {
    const db = mockDb();
    const { sql, params } = db
      .select({ resultBody: taskReviews.resultBody })
      .from(taskReviews)
      .where(and(eq(taskReviews.taskId, 't-1'), eq(taskReviews.round, 2)))
      .limit(1)
      .toSQL();
    expect(sql).toContain('"result_body"');
    expect(sql).toContain('"task_reviews"."task_id" =');
    expect(sql).toContain('"task_reviews"."round" =');
    expect(params).toEqual(['t-1', 2, 1]);
  });

  it('the shipped migration drops task_activity and adds task_reviews.result_body', () => {
    const dir = join(import.meta.dirname, '../../drizzle');
    const folder = readdirSync(dir).find((f) => f.startsWith('20261030'));
    expect(folder).toBeTruthy();
    const sql = readFileSync(join(dir, nonNull(folder), 'migration.sql'), 'utf8');
    expect(sql).toContain('DROP TABLE "task_activity"');
    expect(sql).toContain('ALTER TABLE "task_reviews" ADD COLUMN "result_body" text');
  });
});
