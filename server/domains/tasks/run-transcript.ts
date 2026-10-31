// RUN-TRANSCRIPT LAW (#130 slice 2): a run's transcript text — the streamed
// `output` and the frozen `prompt` — never rides list snapshots. Snapshot
// selects use transcriptSnapshotColumns() (live output + has* flags only);
// every settled transcript and every prompt is fetched on demand through
// tasks.runTranscript (fold-open in the UI). Server-internal readers (brief
// builder, runner settle, reaper marker) keep their own selects.
import { inArray, sql } from 'drizzle-orm';

import { RUN_STATUS } from '#shared/enums';

import { asDb, db, type DbExecutor } from '../../db/index';
import { taskRuns } from '../../db/schema';

/** snapshot-safe transcript columns: `output` rides ONLY for the RUNNING run
 * (the live stream surface) — settled transcripts collapse to NULL in SQL;
 * `hasOutput`/`hasPrompt` tell clients a fold has content to fetch on demand */
export function transcriptSnapshotColumns() {
  return {
    output: sql<string | null>`case when ${taskRuns.status} = ${RUN_STATUS.RUNNING} then ${taskRuns.output} end`,
    hasOutput: sql<boolean>`${taskRuns.output} <> ''`,
    hasPrompt: sql<boolean>`${taskRuns.prompt} is not null`,
  };
}

export type RunTranscript = { id: string; output: string; prompt: string | null };

/** RQB options for the on-demand transcript — the ONE select where output +
 * prompt travel together (exported so unit tests can pin the shape) */
export function runTranscriptScan(runId: string) {
  return {
    columns: { id: true, output: true, prompt: true },
    where: { id: { eq: runId } },
  } as const;
}

/** snapshot bits for a thread's run rows (post-RQB merge): live output + flags */
export function transcriptBitsScan(ex: DbExecutor, runIds: string[]) {
  return asDb(ex)
    .select({ id: taskRuns.id, ...transcriptSnapshotColumns() })
    .from(taskRuns)
    .where(inArray(taskRuns.id, runIds));
}

/** the ONE wire path for a settled run's transcript text and every prompt */
export async function fetchRunTranscript(runId: string): Promise<RunTranscript | null> {
  const row = await db.query.taskRuns.findFirst(runTranscriptScan(runId));
  return row ?? null;
}

export async function loadTranscriptBits(runIds: string[]) {
  if (!runIds.length) return new Map<string, { output: string | null; hasOutput: boolean; hasPrompt: boolean }>();
  const rows = await transcriptBitsScan(db, runIds);
  return new Map(rows.map((r) => [r.id, { output: r.output, hasOutput: r.hasOutput, hasPrompt: r.hasPrompt }]));
}
