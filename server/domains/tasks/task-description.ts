// SNAPSHOT-SLIMMING LAW (#130 slice 3): a task's description body never rides
// list payloads — tasks.list / tasks.listPaged rows ship id..updatedAt only.
// The body travels exclusively through tasks.getDescription (task page brief
// bubble, editor modal prefill), mirroring the RUN-TRANSCRIPT LAW's
// tasks.runTranscript. Server-internal readers (brief builder, listPaged
// search filter) keep their own selects — this module is the WIRE path.
import { db } from '../../db/index';

export type TaskDescription = { id: string; description: string };

/** snapshot-safe list columns — shared verbatim by tasks.list and tasks.listPaged.
 * The description body is NOT a list column (SNAPSHOT-SLIMMING LAW): it travels
 * only via taskDescriptionScan. Exported so unit tests can pin the shape and a
 * drift back into the payload fails loudly (same pattern as
 * transcriptSnapshotColumns for #130 slice 2) */
export function taskListColumns() {
  return {
    id: true,
    title: true,
    status: true,
    projectId: true,
    assigneeId: true,
    ownerId: true,
    createdBy: true,
    reviewers: true,
    parentTaskId: true,
    dispatchAfter: true,
    failStreak: true,
    createdAt: true,
    updatedAt: true,
  } as const;
}

/** RQB options for the on-demand description — the ONE select where the body
 * travels (exported so unit tests can pin the shape) */
export function taskDescriptionScan(taskId: string) {
  return {
    columns: { id: true, description: true },
    where: { id: { eq: taskId } },
  } as const;
}

/** the ONE wire path for a task's description body — null = unknown task
 * (the router maps that to NOT_FOUND) */
export async function fetchTaskDescription(taskId: string): Promise<TaskDescription | null> {
  const row = await db.query.tasks.findFirst(taskDescriptionScan(taskId));
  return row ?? null;
}
