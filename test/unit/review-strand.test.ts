// RESTORE-STRAND DETECTOR (#500): the decision table. The gating restore is the only place
// that can see a re-keyed block home and a still-owed review round together; this pins the
// contract the unblock note's `reviewStrand` payload carries.
import { describe, expect, it } from 'vitest';

import { isRestoreStrand } from '../../server/domains/tasks/review-strand';

const base = {
  recordedCategory: 'in_review',
  ghostAtBlock: false,
  homeCategory: 'done',
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

  it('stays silent when the recorded category matches the home current one (#423, manual moves)', () => {
    expect(isRestoreStrand({ ...base, recordedCategory: 'done' })).toBe(false);
    expect(isRestoreStrand({ ...base, recordedCategory: 'cancelled', homeCategory: 'cancelled' })).toBe(false);
  });

  it('stays silent on a legal WORKING-home demotion (#88: recorded == home, landing is to-do)', () => {
    expect(
      isRestoreStrand({
        ...base,
        recordedCategory: 'working',
        homeCategory: 'working',
        landingCategory: 'ready',
      }),
    ).toBe(false);
  });

  it('stays silent when the home still resolves into review', () => {
    // recorded != home and landing === in_review: ONLY the landing gate can exclude it
    expect(
      isRestoreStrand({
        ...base,
        recordedCategory: 'working',
        homeCategory: 'in_review',
        landingCategory: 'in_review',
      }),
    ).toBe(false);
  });

  it('stays silent without a floored block record (pre-floor note cannot split the row)', () => {
    expect(isRestoreStrand({ ...base, recordedCategory: null })).toBe(false);
  });

  it('fires on a ghost-at-block record that strands a live round (#503)', () => {
    // the block recorded NO category (its home was already a ghost): the re-key test is
    // satisfied by construction, so the landing gate + the decision carry the whole decision
    expect(
      isRestoreStrand({
        ...base,
        recordedCategory: null,
        ghostAtBlock: true,
        homeCategory: undefined,
        landingCategory: 'backlog',
      }),
    ).toBe(true);
    expect(
      isRestoreStrand({
        ...base,
        recordedCategory: null,
        ghostAtBlock: true,
        homeCategory: 'working',
        landingCategory: 'backlog',
        liveRound: false,
        postRecordVerdict: true,
      }),
    ).toBe(true);
  });

  it('stays silent on a ghost-at-block record that lands back in review or has no decision (#503)', () => {
    expect(
      isRestoreStrand({
        ...base,
        recordedCategory: null,
        ghostAtBlock: true,
        homeCategory: 'in_review',
        landingCategory: 'in_review',
      }),
    ).toBe(false);
    expect(
      isRestoreStrand({
        ...base,
        recordedCategory: null,
        ghostAtBlock: true,
        homeCategory: undefined,
        landingCategory: 'backlog',
        liveRound: false,
      }),
    ).toBe(false);
  });

  it('fires when the recorded home no longer resolves and a live decision waits', () => {
    expect(isRestoreStrand({ ...base, homeCategory: undefined })).toBe(true);
  });

  it('stays silent when the recorded home is gone and no review decision waits', () => {
    expect(isRestoreStrand({ ...base, homeCategory: undefined, liveRound: false })).toBe(false);
  });
});
