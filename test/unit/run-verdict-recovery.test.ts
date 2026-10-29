import { describe, expect, it, vi } from 'vitest';

// updateRunMessageBody writes through the server db singleton — capture the SET
// payload instead of touching Postgres (no-real-DB unit law)
const sets: Array<Record<string, unknown>> = [];
vi.mock('../../server/db/index', () => ({
  db: {
    update: () => ({
      set: (v: Record<string, unknown>) => {
        sets.push(v);
        return { where: async () => {} };
      },
    }),
  },
  asDb: (x: unknown) => x,
}));

import { humanRunTail, updateRunMessageBody } from '../../server/domains/tasks/thread.service';
import { parseRunEnvelope } from '../../shared/run-verdict';

// the exact failure shape from task 01a182f2: ONE long single-line blocked verdict
// split by the 400-char force-flush into fragment lines, with telemetry trailing —
// join-to-end and '\n'-joins both parsed null, dropping a real reviewer verdict
// into a pending-round deadlock
const BLOCKED_THEN_TELEMETRY = [
  'nope',
  ...JSON.stringify({
    kind: 'blocked',
    body: 'Not accepted — this submission answers a different task, and the reported bug is still live.\n\nWhat I verified first-hand: the result reports contract-tracking work (PRs #1301/#1310/#1331); queue.service.ts:447 still keys workers per queue.\n\n- add regression coverage for cross-name pickup\n- open a PR against development and report the merge sha',
  }).match(/.{1,120}/g)!,
  '[context] 33868/1000000 tokens',
].join('\n');

describe('parseRunEnvelope grow-window recovery', () => {
  it('parses a pretty-printed verdict with trailing telemetry lines', () => {
    const env = parseRunEnvelope(BLOCKED_THEN_TELEMETRY);
    expect(env?.kind).toBe('blocked');
    expect(env?.text).toContain('Not accepted');
    expect(env?.text).toContain('merge sha');
  });

  it('pretty-printed verdicts (newlines between tokens) still recover', () => {
    const env = parseRunEnvelope(
      ['{', '  "kind": "blocked",', '  "body": "missing coverage"', '}', '[context] 1/1 tokens'].join('\n'),
    );
    expect(env?.kind).toBe('blocked');
    expect(env?.text).toBe('missing coverage');
  });

  it('still prefers the LAST verdict when telemetry separates two', () => {
    const out = [
      '{"kind": "question", "body": "first thought"}',
      '[context] 100/100 tokens',
      '{"kind": "result", "body": "final"}',
    ].join('\n');
    expect(parseRunEnvelope(out)?.kind).toBe('result');
  });

  it('single-line verdicts and no-verdict outputs behave as before', () => {
    expect(parseRunEnvelope('{"kind": "result", "body": "done"}')?.text).toBe('done');
    expect(parseRunEnvelope('just prose, no verdict')).toBeNull();
    expect(parseRunEnvelope('')).toBeNull();
  });
});

describe('humanRunTail', () => {
  it('strips system telemetry and keeps the agent prose', () => {
    const out = [
      'worked on the fix',
      '[context] 100/100 tokens',
      '[tool] terminal: ls',
      '[tool] tool completed',
      'found the root cause',
      '[dispatch] out-dir prepare failed: x',
      '[retry] attempt 1/4 failed — retrying with backoff',
    ].join('\n');
    expect(humanRunTail(out)).toBe('worked on the fix\nfound the root cause');
  });

  it('caps the tail and never returns empty', () => {
    expect(humanRunTail('[context] 1/1 tokens\n[tool] x')).toBe('run complete');
    expect(humanRunTail(null)).toBe('run complete');
    const many = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(humanRunTail(many).split('\n')).toHaveLength(12);
    expect(humanRunTail(many).startsWith('line 19')).toBe(true);
  });
});

describe('updateRunMessageBody fallback', () => {
  it('envelope text wins over the human tail', async () => {
    await updateRunMessageBody('m-1', 'work\n{"kind": "result", "body": "the answer"}');
    expect(sets.at(-1)?.body).toBe('the answer');
  });

  it('no envelope: the run message gets the human tail, not tool spam', async () => {
    await updateRunMessageBody(
      'm-2',
      'real answer here\n[context] 33868/1000000 tokens\n[tool] terminal: ls\n[tool] tool completed',
    );
    expect(sets.at(-1)?.body).toBe('real answer here');
  });

  it('no envelope, no prose: still a readable line, never blank', async () => {
    await updateRunMessageBody('m-3', '[context] 1/1 tokens');
    expect(sets.at(-1)?.body).toBe('run complete');
  });
});
