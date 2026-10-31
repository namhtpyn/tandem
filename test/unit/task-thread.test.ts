import { describe, expect, it } from 'vitest';

import { ACTIVITY_KIND, REVIEW_STATUS, RUN_STATUS } from '#shared/enums';

import { buildThread, parseRunEnvelope } from '../../app/utils/task-thread.ts';

describe('parseRunEnvelope', () => {
  it('parses a JSON verdict on the last line', () => {
    expect(parseRunEnvelope('work\n{"kind": "result", "body": "shipped v1"}')).toEqual({
      kind: 'result',
      text: 'shipped v1',
    });
    expect(parseRunEnvelope('{"kind": "question", "body": "which db?"}')).toEqual({
      kind: 'question',
      text: 'which db?',
    });
    expect(parseRunEnvelope('{"kind": "blocked", "body": "no key"}')).toEqual({ kind: 'blocked', text: 'no key' });
  });
  it('takes the LAST verdict when several appear', () => {
    expect(
      parseRunEnvelope('{"kind": "result", "body": "old"}\nmore\n{"kind": "question", "body": "final?"}')?.kind,
    ).toBe('question');
  });
  it('returns null for no verdict or empty output', () => {
    expect(parseRunEnvelope('plain output')).toBeNull();
    expect(parseRunEnvelope('')).toBeNull();
    expect(parseRunEnvelope(null)).toBeNull();
  });
});

describe('structured verdicts (zod)', () => {
  it('tolerates a code fence around the JSON', () => {
    expect(parseRunEnvelope('work\n```json\n{"kind": "result", "body": "ok"}\n```')).toEqual({
      kind: 'result',
      text: 'ok',
    });
  });
  it('rejects invalid kinds and missing body (zod)', () => {
    expect(parseRunEnvelope('{"kind": "victory", "body": "nope"}')).toBeNull();
    expect(parseRunEnvelope('{"kind": "result"}')).toBeNull();
  });
  it('schema rejects non-object JSON', () => {
    expect(parseRunEnvelope('"just a string"')).toBeNull();
    expect(parseRunEnvelope('[1,2,3]')).toBeNull();
  });
});

describe('buildThread', () => {
  it('description becomes the first bubble even when newer than runs', () => {
    const items = buildThread({
      description: 'do the thing',
      createdAt: '2026-01-03T00:00:00Z',
      runs: [
        {
          id: 'r1',
          status: RUN_STATUS.DONE,
          output: 'x',
          exitCode: 0,
          startedAt: '2026-01-01T00:00:00Z',
          finishedAt: null,
        },
      ],
      activity: [
        { id: 'a1', noteKind: ACTIVITY_KIND.QUESTION, body: 'q', authorName: 'Nam', createdAt: '2026-01-02T00:00:00Z' },
      ],
    });
    expect(items[0]?.kind).toBe('brief');
    expect(items.map((i) => i.id)).toEqual(['brief', 'r1', 'a1']);
  });
  it('interleaves runs and activity chronologically with id tiebreak', () => {
    const items = buildThread({
      runs: [
        {
          id: 'r2',
          status: RUN_STATUS.DONE,
          output: '',
          exitCode: 0,
          startedAt: '2026-01-02T00:00:00Z',
          finishedAt: null,
        },
        {
          id: 'r1',
          status: RUN_STATUS.DONE,
          output: '',
          exitCode: 0,
          startedAt: '2026-01-01T00:00:00Z',
          finishedAt: null,
        },
      ],
      activity: [{ id: 'a9', noteKind: 'status', body: '', authorName: null, createdAt: '2026-01-03T00:00:00Z' }],
    });
    expect(items.map((i) => i.id)).toEqual(['r1', 'r2', 'a9']);
  });
  it('carries the brief author (task creator) through', () => {
    const items = buildThread({
      description: 'do it',
      createdAt: '2026-01-01T00:00:00Z',
      briefAuthorName: 'Nam',
    });
    expect(items[0].kind === 'brief' && items[0].authorName).toBe('Nam');
    const none = buildThread({ description: 'do it', createdAt: '2026-01-01T00:00:00Z' });
    expect(none[0].kind === 'brief' && none[0].authorName).toBeNull();
  });

  it('omits the brief when description is empty/whitespace', () => {
    expect(buildThread({ description: '   ', runs: [], activity: [] })).toEqual([]);
  });
  it('carries run prompt through when the source provides it', () => {
    const items = buildThread({
      runs: [
        {
          id: 'r1',
          status: RUN_STATUS.DONE,
          output: 'out',
          prompt: 'please do it',
          agentName: 'Jay',
          exitCode: 0,
          startedAt: '2026-01-01T00:00:00Z',
          finishedAt: null,
        },
      ],
    });
    expect(items[0].kind === 'run' && items[0].agentName).toBe('Jay');
    expect(items[0].kind === 'run' && items[0].prompt).toBe('please do it');
    const none = buildThread({
      runs: [
        {
          id: 'r2',
          status: RUN_STATUS.DONE,
          output: '',
          exitCode: 0,
          startedAt: '2026-01-01T00:00:00Z',
          finishedAt: null,
        },
      ],
    });
    expect(none[0].kind === 'run' && none[0].prompt).toBeUndefined();
  });

  it('carries run fields through', () => {
    const [item] = buildThread({
      runs: [
        { id: 'r1', status: RUN_STATUS.RUNNING, output: 'partial', exitCode: null, startedAt: 't', finishedAt: null },
      ],
    });
    expect(item).toMatchObject({ kind: 'run', status: RUN_STATUS.RUNNING, output: 'partial', exitCode: null });
  });

  it('carries the transcript flags and a null settled output through (RUN-TRANSCRIPT LAW)', () => {
    const [item] = buildThread({
      runs: [
        {
          id: 'r1',
          status: RUN_STATUS.DONE,
          output: null,
          hasOutput: true,
          hasPrompt: false,
          exitCode: 0,
          startedAt: 't',
          finishedAt: 't2',
        },
      ],
    });
    expect(item).toMatchObject({ kind: 'run', output: null, hasOutput: true, hasPrompt: false });
  });
});

describe('buildThread degenerate sources', () => {
  it('no runs and no activity keys at all yields brief only', () => {
    expect(buildThread({ description: 'solo', createdAt: 't' }).map((i) => i.kind)).toEqual(['brief']);
  });
  it('prose after the verdict: window still finds it (last JSON line wins)', () => {
    const out = '{"kind": "result", "body": "early"}\ntail line\nmore tail';
    expect(parseRunEnvelope(out)?.kind).toBe('result');
  });
  it('empty-string description (falsy) omits brief via the other arm', () => {
    expect(buildThread({ description: '', runs: [], activity: [] })).toEqual([]);
  });
  it('brief falls back to empty createdAt when absent', () => {
    const [b] = buildThread({ description: 'x' });
    expect(b).toMatchObject({ kind: 'brief', createdAt: '' });
  });
  it('equal timestamps order by id (tiebreak arm)', () => {
    const items = buildThread({
      runs: [
        {
          id: 'rb',
          status: RUN_STATUS.DONE,
          output: '',
          exitCode: 0,
          startedAt: '2026-01-01T00:00:00Z',
          finishedAt: null,
        },
        {
          id: 'ra',
          status: RUN_STATUS.DONE,
          output: '',
          exitCode: 0,
          startedAt: '2026-01-01T00:00:00Z',
          finishedAt: null,
        },
      ],
    });
    expect(items.map((i) => i.id)).toEqual(['ra', 'rb']);
  });
});

import { activityNotes, noteKindOf, threadTime } from '../../app/utils/task-thread.ts';

describe('noteKindOf / activityNotes / threadTime', () => {
  it('normalizes legacy casings and rejects unknown kinds', () => {
    expect(noteKindOf({ kind: 'question' })).toBe(ACTIVITY_KIND.QUESTION);
    expect(noteKindOf({ kind: 'VERDICT' })).toBe(ACTIVITY_KIND.VERDICT);
    expect(noteKindOf({ kind: 'weird' })).toBeNull();
    expect(noteKindOf({ kind: '' })).toBeNull();
    expect(noteKindOf({ other: 1 })).toBeNull();
    expect(noteKindOf(null)).toBeNull();
    expect(noteKindOf(undefined)).toBeNull();
  });

  it('activityNotes keeps only rows with a known kind', () => {
    const rows = [
      {
        id: 'a',
        body: 'x',
        authorName: 'A',
        authorId: 'a1',
        createdAt: '2026-01-01T00:00:00Z',
        activity: { kind: 'note' },
      },
      {
        id: 'b',
        body: 'y',
        authorName: 'B',
        authorId: 'b1',
        createdAt: '2026-01-02T00:00:00Z',
        activity: { kind: 'zap' },
      },
      { id: 'c', body: 'z', authorName: 'C', authorId: 'c1', createdAt: '2026-01-03T00:00:00Z', activity: null },
    ];
    const out = activityNotes(rows);
    expect(out.map((r) => r.id)).toEqual(['a']);
    expect(out[0]?.noteKind).toBe(ACTIVITY_KIND.NOTE);
  });

  it('threadTime reads startedAt for runs and createdAt for the rest', () => {
    expect(threadTime({ kind: 'run', startedAt: 't1' } as never)).toBe('t1');
    expect(threadTime({ kind: 'run' } as never)).toBeNull();
    expect(threadTime({ kind: 'note', createdAt: 't2' } as never)).toBe('t2');
    expect(threadTime({ kind: 'note' } as never)).toBeNull();
  });
});
