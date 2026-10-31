// LIVENESS SWEEP + UNBLOCK RESTORE law (#88, 2026-10-31): a task in a working-category
// status must be backed by a live run — one whose newest run is settled (or that has no
// runs) for > 15 min bounces back to to-do; the subtask unblock never restores to a
// working status (the dispatcher scans ready-category only) and never writes an
// unknown/malformed status id (this write bypasses the setStatus membership guard).
import { describe, expect, it } from 'vitest';

import { LIVENESS_GRACE_MS, livenessBounce } from '#server/domains/tasks/dispatcher.service';
import { resolveRestoreTarget } from '#server/domains/tasks/gating.service';
import { RUN_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const MIN = 60_000;

const base = {
  category: 'working',
  isAiAssignee: true,
  newestRunStatus: RUN_STATUS.DONE as string | null,
  newestRunSettledAt: new Date(NOW - 20 * MIN),
  updatedAt: new Date(NOW - 20 * MIN),
};

describe('livenessBounce (sweep decision)', () => {
  it('bounces a working task whose newest run settled past the grace', () => {
    expect(livenessBounce(base, NOW)).toBe(true);
    expect(LIVENESS_GRACE_MS).toBe(15 * MIN);
  });

  it('spares a fresh settled run (inside grace)', () => {
    expect(livenessBounce({ ...base, newestRunSettledAt: new Date(NOW - 5 * MIN) }, NOW)).toBe(false);
  });

  it('spares a live run', () => {
    expect(livenessBounce({ ...base, newestRunStatus: RUN_STATUS.RUNNING, newestRunSettledAt: null }, NOW)).toBe(false);
  });

  it('bounces a zero-run working task idle past grace (updatedAt is the idle clock)', () => {
    const zeroRuns = { newestRunStatus: null, newestRunSettledAt: null };
    expect(livenessBounce({ ...base, ...zeroRuns, updatedAt: new Date(NOW - 20 * MIN) }, NOW)).toBe(true);
    expect(livenessBounce({ ...base, ...zeroRuns, updatedAt: new Date(NOW - 2 * MIN) }, NOW)).toBe(false);
  });

  it('treats a settled run with a missing finished_at as idle since updatedAt', () => {
    expect(livenessBounce({ ...base, newestRunSettledAt: null }, NOW)).toBe(true);
  });

  it('exempts human-assigned tasks (manual status freedom)', () => {
    expect(livenessBounce({ ...base, isAiAssignee: false }, NOW)).toBe(false);
  });

  it('only touches working-category statuses', () => {
    for (const category of ['ready', 'done', 'paused', 'waiting_answer', 'in_review', 'cancelled', null]) {
      expect(livenessBounce({ ...base, category }, NOW)).toBe(false);
    }
  });

  it('honors a custom grace (reaper parity in tests)', () => {
    expect(livenessBounce(base, NOW, 30 * MIN)).toBe(false);
    expect(livenessBounce({ ...base, newestRunSettledAt: new Date(NOW - 31 * MIN) }, NOW, 30 * MIN)).toBe(true);
  });
});

const KNOWN = new Map<string, string>([
  [STATUS.doing, 'working'],
  [STATUS.todo, 'ready'],
  [STATUS.done, 'done'],
  [STATUS.waitingAnswer, 'waiting_answer'],
  [STATUS.inReview, 'in_review'],
  [STATUS.blocked, 'paused'],
  [STATUS.cancelled, 'cancelled'],
]);

describe('resolveRestoreTarget (unblock restore law)', () => {
  it('restores non-working known statuses verbatim', () => {
    expect(resolveRestoreTarget(STATUS.waitingAnswer, KNOWN)).toBe(STATUS.waitingAnswer);
    expect(resolveRestoreTarget(STATUS.inReview, KNOWN)).toBe(STATUS.inReview);
    expect(resolveRestoreTarget(STATUS.done, KNOWN)).toBe(STATUS.done);
    expect(resolveRestoreTarget(STATUS.todo, KNOWN)).toBe(STATUS.todo);
  });

  it('downgrades a working-category restore to to-do (the dispatcher re-claims it)', () => {
    expect(resolveRestoreTarget(STATUS.doing, KNOWN)).toBe(STATUS.todo);
  });

  it('falls back to to-do on an unknown/malformed id (never a dangling tasks.status)', () => {
    expect(resolveRestoreTarget('doing', KNOWN)).toBe(STATUS.todo); // legacy literal
    expect(resolveRestoreTarget('01a14743-0000-0000-0000-000000000000', KNOWN)).toBe(STATUS.todo);
  });
});
