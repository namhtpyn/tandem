// task thread: one ordered conversation per task — base message rows; a run's
// thread presence is task_runs.message_id (the task is reached via the message).
// The thread IS the activity store (task_activity retired 2026-10-30).
import { and, eq, inArray, isNull, or } from 'drizzle-orm';

import { parseReviewEnvelope, parseRunEnvelope } from '#shared/run-verdict';
import { nonNull } from '#shared/utils/non-null';

import { db, asDb, type DbExecutor } from '../../db/index';
import { taskAttachments, taskMessageActivities, taskMessages } from '../../db/schema';
import { activityKindOf } from './brief.service';
import { dropEchoNotes } from './echo-notes';
import { loadTranscriptBits } from './run-transcript';

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

/** activity side of the thread — the structured payload lives on the message's
 * task_message_activities extension row, so this places base row + extension */
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
// [context]/[tool]/[dispatch]/[retry]/[reaper] streaming telemetry — never a result
const SYSTEM_LINE = /^\[(context|tool|dispatch|retry|reaper|warn|settle|collect)\b/i;

/** envelope text, else the human tail of the transcript (system lines stripped) —
 * a run's own message must always carry the agent's answer (owner law 2026-10-29:
 * task 01a182f2 shipped a blank run message + a tool-spam submission message) */
export function humanRunTail(output: string | null | undefined, maxLines = 12): string {
  const lines = (output ?? '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '' && !SYSTEM_LINE.test(l.trim()));
  return lines.slice(-maxLines).join('\n').trim() || 'run complete';
}

export async function updateRunMessageBody(messageId: string, output: string, review = false) {
  // review turns speak the verdict vocabulary — parse with the review schema so the
  // run bubble carries the verdict itself, not the transcript tail around it
  const envelope = review
    ? (parseReviewEnvelope((output ?? '').trimEnd()) ?? parseRunEnvelope((output ?? '').trimEnd()))
    : parseRunEnvelope((output ?? '').trimEnd());
  const body = envelope?.text ?? humanRunTail(output);
  await db.update(taskMessages).set({ body }).where(eq(taskMessages.id, messageId));
}

/** RESULT-MESSAGE ATTACHMENTS (SPEC 2026-10-31): append the collected-image tokens
 * AFTER the parsed result body — the write must follow updateRunMessageBody (which
 * owns the body) or the tokens are overwritten. Blank body -> tokens only. */
export async function appendMessageAttachments(messageId: string, tokens: string[]) {
  if (!tokens.length) return;
  const row = await db.query.taskMessages.findFirst({ columns: { body: true }, where: { id: messageId } });
  if (!row) return;
  const body = row.body?.trim() ? `${row.body}\n\n${tokens.join('\n')}` : tokens.join('\n');
  await db.update(taskMessages).set({ body }).where(eq(taskMessages.id, messageId));
}

/** one ordered thread: base rows with their run + author attached —
 * RUN-TRANSCRIPT LAW (#130 slice 2): the RQB never selects transcript text;
 * live output + flags ride via the post-merge bits query (run-transcript.ts) */
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

  const deduped = dropEchoNotes(visible);

  const runIds = deduped.flatMap((m) => (m.run ? [m.run.id] : []));
  // live output + has* flags for the thread's runs (transcript text never rides)
  const bitsByRun = await loadTranscriptBits(runIds);
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
          // RUN-TRANSCRIPT LAW: output rides only while RUNNING (bits query);
          // settled transcripts + prompts fetch on demand via tasks.runTranscript
          output: bitsByRun.get(runRow.id)?.output ?? null,
          hasOutput: bitsByRun.get(runRow.id)?.hasOutput ?? false,
          hasPrompt: bitsByRun.get(runRow.id)?.hasPrompt ?? false,
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
export { dropEchoNotes } from './echo-notes';
