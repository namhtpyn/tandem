// RUN-TRANSCRIPT LAW (#130 slice 2): transcript text never rides list snapshots.
// These tests pin the SHAPES the wire actually issues: the runs-list select
// ships live output + has* flags only (output behind a CASE on RUNNING, prompt
// behind `is not null`), the thread's bits query reads the same snapshot-safe
// columns by run ids, and the on-demand transcript scan is the ONE select where
// output + prompt travel together.
import { describe, expect, it } from 'vitest';

import { runTranscriptScan, transcriptBitsScan, transcriptSnapshotColumns } from '#server/domains/tasks/run-transcript';
import { runsListScan } from '#server/domains/tasks/runner.service';

import { mockDb } from './helpers/mock-db';

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('runs-list scan shape (#130 slice 2)', () => {
  it('carries output ONLY behind the RUNNING case — never as a bare column', () => {
    const { sql } = runsListScan(mockDb(), 'task-1').toSQL();
    expect(sql).toContain('case when');
    expect(sql).toContain('"task_runs"."status" =');
    expect(sql).toContain('then "task_runs"."output"');
    // "output" appears exactly twice: the CASE's live branch + the hasOutput flag
    expect(count(sql, '"output"')).toBe(2);
  });

  it('ships the has* flags as SQL booleans, prompt never as a selected column', () => {
    const { sql } = runsListScan(mockDb(), 'task-1').toSQL();
    expect(sql).toContain(`"task_runs"."output" <> ''`);
    expect(sql).toContain('"task_runs"."prompt" is not null');
    // "prompt" appears exactly once: the hasPrompt flag expression
    expect(count(sql, '"prompt"')).toBe(1);
  });

  it('still joins the message for the task filter (runs are message-first)', () => {
    const { sql, params } = runsListScan(mockDb(), 'task-1').toSQL();
    expect(sql).toContain('"task_messages"');
    expect(params).toContain('task-1');
  });
});

describe('thread transcript-bits scan shape (#130 slice 2)', () => {
  it('reads the same snapshot-safe columns filtered by run id', () => {
    const { sql, params } = transcriptBitsScan(mockDb(), ['r-1', 'r-2']).toSQL();
    expect(sql).toContain('case when');
    expect(sql).toContain('"prompt" is not null');
    expect(sql).toContain(`"output" <> ''`);
    expect(sql).toContain('"id" in');
    expect(params).toContain('r-1');
    expect(params).toContain('r-2');
  });

  it('projects exactly the snapshot-safe column set (no transcript text key)', () => {
    const cols = transcriptSnapshotColumns();
    expect(Object.keys(cols).sort()).toEqual(['hasOutput', 'hasPrompt', 'output']);
  });
});

describe('on-demand transcript scan (#130 slice 2)', () => {
  it('is the ONE select where output + prompt travel together, keyed by run id', () => {
    const db = mockDb();
    const { sql, params } = db.query.taskRuns.findFirst(runTranscriptScan('r-9')).toSQL();
    expect(sql).toContain('"output" as "output"');
    expect(sql).toContain('"prompt" as "prompt"');
    expect(sql).toContain('."id" =');
    expect(params).toContain('r-9');
  });
});
