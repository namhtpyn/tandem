// RESTORE-STRAND DETECTOR (#500): the decision table. The gating restore is the only place
// that can see a re-keyed block home and a still-owed review round together; this pins the
// contract the unblock note's `reviewStrand` payload carries.
import { describe, expect, it } from 'vitest';

import { isRestoreStrand } from '../../server/domains/tasks/review-strand';

const base = {
  recordedCategory: 'in_review',
  landingCategory: 'done',
  liveRound: true,
  postRecordVerdict: false,
};

describe('restore-strand detector (#500)', () => {
  it('fires on a re-keyed home that strands a live round', () => {
    expect(isRestoreStrand(base)).toBe(true);
  });

  it('fires on a decided round whose verdict landed after the block record', () => {
    expect(isRestoreStrand({ ...base, liveRound: false, postRecordVerdict: true })).toBe(true);
  });

  it('stays silent without a review decision to strand', () => {
    expect(isRestoreStrand({ ...base, liveRound: false })).toBe(false);
  });

  it('stays silent when the recorded category matches the landing one (#423, manual moves)', () => {
    expect(isRestoreStrand({ ...base, recordedCategory: 'done' })).toBe(false);
    expect(isRestoreStrand({ ...base, landingCategory: 'in_review' })).toBe(false);
  });

  it('stays silent without a floored block record (pre-floor note cannot split the row)', () => {
    expect(isRestoreStrand({ ...base, recordedCategory: null })).toBe(false);
  });

  it('stays silent when the landing status does not resolve (dangling home is the ORPHAN-HOME arm)', () => {
    expect(isRestoreStrand({ ...base, landingCategory: undefined })).toBe(false);
  });
});
