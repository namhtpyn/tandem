// task thread: one ordered conversation per task — base message rows; a run's
// thread presence is task_runs.message_id (the task is reached via the message).
// Activity rows dual-write task_activity during the transition.
import { and, eq, inArray, isNull, or } from 'drizzle-orm';

import { parseRunEnvelope } from '#shared/run-verdict';
import { nonNull } from '#shared/utils/non-null';

import { db, asDb, type DbExecutor } from '../../db/index';
import { taskAttachments, taskMessageActivities, taskMessages } from '../../db/schema';
import { activityKindOf } from './brief.service';

/** jsonb payloads arrive as raw strings through RQB relation selects — parse once so the
 * client gets an object; corrupt/non-object payloads ship as null instead of a dead string */
export function normalizeActivityPayload(payload: unknown): Record<string, unknown> | null {
  /* v8 ignore next 2 -- jsonb payloads are object-or-string by construction; arms kept total */
  if (payload !== null && typeof payload === 'object') return payload as Record<string, unknown>;
  if (typeof payload !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    /* v8 ignore next */
    return null;
  }
}

/** the blank-body message a dispatch creates before its run row exists */
export async function createRunMessage(
  input: { taskId: string; authorId: string | null; createdAt?: Date },
  ex: DbExecutor = db,
) {
  const d = asDb(ex);
  const rows = await d
    .insert(taskMessages)
    .values({
      taskId: input.taskId,
      authorId: input.authorId,
      body: '',
      createdAt: input.createdAt ?? new Date(),
    })
    .returning({ id: taskMessages.id });
  // insert...returning always yields the row — nonNull is a type guard only
  return nonNull(rows[0]).id;
}

/** activity side of the thread — the structured payload lives in task_activity
 * during the dual-write window, so this only places the base row */
export async function insertActivityMessage(
  input: { taskId: string; authorId: string | null; body: string; payload: Record<string, unknown> },
  ex: DbExecutor = db,
) {
  const d = asDb(ex);
  const rows = await d
    .insert(taskMessages)
    .values({
      taskId: input.taskId,
      authorId: input.authorId,
      body: input.body,
      createdAt: new Date(),
    })
    .returning({ id: taskMessages.id });
  await d.insert(taskMessageActivities).values({ messageId: nonNull(rows[0]).id, payload: input.payload });
}

/** the run settled: the thread message body becomes the parsed result */
export async function updateRunMessageBody(messageId: string, output: string) {
  const body = parseRunEnvelope((output ?? '').trimEnd())?.text ?? '';
  await db.update(taskMessages).set({ body }).where(eq(taskMessages.id, messageId));
}

/** one ordered thread: base rows with their run + author attached */
export async function listTaskThread(taskId: string) {
  const messages = await db.query.taskMessages.findMany({
    where: { taskId },
    orderBy: { createdAt: 'asc', id: 'asc' },
    with: {
      author: { columns: { name: true } },
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
      activityExt: { columns: { payload: true } },
    },
  });

  // STATUS rows are pipeline chatter (dispatch/review bookkeeping) — never thread items
  // (payload arrives as a raw jsonb string, so the kind check goes through activityKindOf)
  const visible = messages.filter((m) => activityKindOf(m.activityExt?.payload) !== 'status');

  // agent-side runners echo the settled result as a plain note seconds after the run
  // message carries the same body — the run turn already renders it, so drop the echo
  const runBodyByAuthor = new Map<string, { body: string; at: number }>();
  for (const m of visible) {
    if (m.run && m.body && m.authorId)
      runBodyByAuthor.set(m.authorId, { body: m.body, at: Date.parse(String(m.createdAt)) });
  }
  const deduped = visible.filter((m) => {
    if (m.run || !m.body || !m.authorId) return true;
    const run = runBodyByAuthor.get(m.authorId);
    if (!run || run.body !== m.body) return true;
    const at = Date.parse(String(m.createdAt));
    return !(at > run.at && at - run.at <= 120_000);
  });

  const runIds = deduped.flatMap((m) => (m.run ? [m.run.id] : []));
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
  const employeeIds = [...new Set(deduped.flatMap((m) => (m.run?.employeeId ? [m.run.employeeId] : [])))];
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

  return deduped.map((m) => {
    const runRow = m.run;
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
      activity: normalizeActivityPayload(m.activityExt?.payload),
    };
  });
}

// re-exported so callers of the old helper keep one import site
export { taskMessageActivities, taskMessages };
