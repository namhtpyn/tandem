// task thread: one ordered conversation per task — base message rows with
// per-kind extension tables (run / activity). The kind is whichever extension
// exists; emitters dual-write task_activity during the transition.
import { and, eq, inArray, isNull, or } from 'drizzle-orm';

import { db } from '../../db/index';
import { nonNull } from '#shared/utils/non-null';
import { taskAttachments, taskMessageActivities, taskMessageRuns, taskMessages } from '../../db/schema';

type MessageInsert = {
  taskId: string;
  authorId: string | null;
  body: string;
  createdAt?: Date;
};

/** base row + run extension — the thread's run turn (output stays on task_runs) */
export async function insertRunMessage(input: MessageInsert & { runId: string }) {
  const rows = await db
    .insert(taskMessages)
    .values({
      taskId: input.taskId,
      authorId: input.authorId,
      body: input.body,
      createdAt: input.createdAt ?? new Date(),
    })
    .returning({ id: taskMessages.id });
  // insert...returning always yields the row — nonNull is a type guard only
  await db.insert(taskMessageRuns).values({ messageId: nonNull(rows[0]).id, runId: input.runId });
}

/** base row + activity extension — payload carries the activity kind + detail */
export async function insertActivityMessage(input: MessageInsert & { payload: Record<string, unknown> }) {
  const rows = await db
    .insert(taskMessages)
    .values({
      taskId: input.taskId,
      authorId: input.authorId,
      body: input.body,
      createdAt: input.createdAt ?? new Date(),
    })
    .returning({ id: taskMessages.id });
  // insert...returning always yields the row — nonNull is a type guard only
  await db.insert(taskMessageActivities).values({ messageId: nonNull(rows[0]).id, payload: input.payload });
}

/** one ordered thread: base rows with their extension + run payload attached */
export async function listTaskThread(taskId: string) {
  const messages = await db.query.taskMessages.findMany({
    where: { taskId },
    orderBy: { createdAt: 'asc', id: 'asc' },
    with: {
      author: { columns: { name: true } },
      runExt: {
        with: {
          run: {
            columns: {
              id: true,
              status: true,
              output: true,
              prompt: true,
              exitCode: true,
              startedAt: true,
              finishedAt: true,
              employeeId: true,
            },
          },
        },
      },
      activityExt: { columns: { payload: true } },
    },
  });

  const runIds = messages.flatMap((m) => (m.runExt?.run ? [m.runExt.run.id] : []));
  const outputs = runIds.length
    ? await db
        .select({
          runId: taskAttachments.runId,
          id: taskAttachments.id,
          filename: taskAttachments.filename,
          mime: taskAttachments.mime,
          size: taskAttachments.size,
        })
        .from(taskAttachments)
        .where(
          and(
            eq(taskAttachments.kind, 'output'),
            or(inArray(taskAttachments.runId, runIds), isNull(taskAttachments.runId)),
          ),
        )
    : [];
  // run payload needs the same ISO + agent-name mapping the runs snapshot uses
  const employeeIds = [
    ...new Set(messages.flatMap((m) => (m.runExt?.run?.employeeId ? [m.runExt.run.employeeId] : []))),
  ];
  const users = employeeIds.length
    ? await db.query.user.findMany({ columns: { id: true, name: true }, where: { id: { in: employeeIds } } })
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.name]));

  const outputsByRun = new Map<string, typeof outputs>();
  for (const o of outputs) {
    if (!o.runId) continue;
    const list = outputsByRun.get(o.runId) ?? [];
    list.push(o);
    outputsByRun.set(o.runId, list);
  }

  return messages.map((m) => {
    const runRow = m.runExt?.run;
    const run = runRow
      ? {
          ...runRow,
          startedAt: runRow.startedAt.toISOString(),
          finishedAt: runRow.finishedAt ? runRow.finishedAt.toISOString() : null,
          // `?? null` unreachable by FK (employee_id references user.id) — defensive only
          /* v8 ignore next */
          agentName: runRow.employeeId ? (nameById.get(runRow.employeeId) ?? null) : null,
          outputs: outputsByRun.get(runRow.id) ?? [],
        }
      : null;
    return {
      id: m.id,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
      authorId: m.authorId,
      authorName: m.author?.name ?? null,
      run,
      activity: m.activityExt?.payload ?? null,
    };
  });
}

// re-exported so callers of the old helper keep one import site
export { taskMessageActivities, taskMessageRuns, taskMessages };
