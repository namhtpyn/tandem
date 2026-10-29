import { describe, expect, it } from 'vitest';

import { parseReviewEnvelope, parseRunEnvelope } from '#shared/run-verdict';

// FINAL SPEC v2 (owner-locked 2026-10-29): the review envelope speaks the verdict
// vocabulary and is STRICT — legacy result/blocked kinds are unknown here.
describe('review envelope parser (strict)', () => {
  it('parses the three verdict kinds + escalate', () => {
    expect(parseReviewEnvelope('x\n{"kind": "approved", "body": "ship it"}')).toEqual({
      kind: 'approved',
      text: 'ship it',
    });
    expect(parseReviewEnvelope('{"kind": "rejected", "body": "wrong direction"}')).toEqual({
      kind: 'rejected',
      text: 'wrong direction',
    });
    expect(parseReviewEnvelope('{"kind": "request_change", "body": "fix the flake"}')).toEqual({
      kind: 'request_change',
      text: 'fix the flake',
    });
    expect(
      parseReviewEnvelope('{"kind": "escalate", "body": "escalate to Zed for reviewing — no vault access"}'),
    ).toEqual({ kind: 'escalate', text: 'escalate to Zed for reviewing — no vault access' });
  });

  it('REJECTS legacy work kinds — result/blocked read as verdict-less', () => {
    expect(parseReviewEnvelope('{"kind": "result", "body": "old habit"}')).toBeNull();
    expect(parseReviewEnvelope('{"kind": "blocked", "body": "old habit"}')).toBeNull();
    expect(parseReviewEnvelope('{"kind": "question", "body": "old habit"}')).toBeNull();
  });

  it('is fence-tolerant and multi-line like the work parser', () => {
    expect(
      parseReviewEnvelope('working...\n```json\n{"kind": "approved",\n "body": "ok"}\n```\n[context] 1/2'),
    ).toEqual({ kind: 'approved', text: 'ok' });
  });

  it('the work parser still speaks ONLY the work vocabulary', () => {
    expect(parseRunEnvelope('{"kind": "approved", "body": "x"}')).toBeNull();
    expect(parseRunEnvelope('{"kind": "result", "body": "x"}')).toEqual({ kind: 'result', text: 'x' });
  });
});
