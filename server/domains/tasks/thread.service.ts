// task thread: one ordered conversation per task — base message rows; a run's
// thread presence is task_runs.message_id (the task is reached via the message).
// The thread IS the activity store (task_activity retired 2026-10-30).
import { and, eq, inArray } from 'drizzle-orm';

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

/** THREAD BOUNDING LAW (#175): thread payloads are bounded pages, never fetch-alls.
 * THREAD_PAGE = visible items per page; THREAD_RAW_WINDOW = raw scan cap per page
 * (status chatter excluded AFTER the scan, so the window overshoots the page). */
export const THREAD_PAGE = 200;
export const THREAD_RAW_WINDOW = 600;

/** row shape the RQB page scan returns (author + run + activity extension attached) */
type ThreadScanRow = Awaited<ReturnType<typeof scanThreadWindow>>[number];

/** one bounded raw window of thread rows, newest-window-first when descending.
 * `before` cuts strictly below the cursor ((createdAt,id) tuple — id breaks ties). */
function scanThreadWindow(taskId: string, before?: { createdAt: Date; id: string }) {
  return db.query.taskMessages.findMany({
    where: before
      ? {
          taskId,
          OR: [
            { createdAt: { lt: before.createdAt } },
            { AND: [{ createdAt: { eq: before.createdAt } }, { id: { lt: before.id } }] },
          ],
        }
      : { taskId },
    orderBy: { createdAt: 'desc', id: 'desc' },
    limit: THREAD_RAW_WINDOW,
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
}

/** true iff raw rows older than `oldest` exist beyond a full scan window */
async function hasOlderRaw(taskId: string, oldest: { createdAt: Date; id: string }) {
  const beyond = await db.query.taskMessages.findMany({
    where: {
      taskId,
      OR: [
        { createdAt: { lt: oldest.createdAt } },
        { AND: [{ createdAt: { eq: oldest.createdAt } }, { id: { lt: oldest.id } }] },
      ],
    },
    columns: { id: true },
    limit: 1,
  });
  return beyond.length > 0;
}

/** window rows (newest-first) -> {items asc, hasMore}; the visible filter + echo
 * dedupe apply BEFORE the page cap, then the NEWEST THREAD_PAGE items ride.
 * Echo dedupe stays window-local by construction: a run always precedes its own
 * echo in (createdAt,id) order, so a cursor boundary can never split an echo from
 * its run — both land on the same page. */
async function pageFromWindow(taskId: string, window: ThreadScanRow[]) {
  // STATUS rows are pipeline chatter (dispatch/review bookkeeping) — never thread items
  // (payload arrives as a raw jsonb string, so the kind check goes through activityKindOf)
  const visible = window.filter((m) => activityKindOf(m.activityExt?.payload) !== 'status');

  const deduped = dropEchoNotes(visible);

  const pageRows = deduped.slice(0, THREAD_PAGE).reverse();
  // hasMore covers BOTH truncation sources: visible items beyond the page cap
  // (dropped tail above) or raw rows beyond a full scan window (one EXISTS probe)
  const oldest = window.at(-1);
  const hasMore =
    deduped.length > THREAD_PAGE ||
    (window.length === THREAD_RAW_WINDOW && oldest ? await hasOlderRaw(taskId, oldest) : false);
  return { pageRows, hasMore };
}

/** one bounded thread page: base rows with their run + author attached —
 * RUN-TRANSCRIPT LAW (#130 slice 2): the RQB never selects transcript text;
 * live output + flags ride via the post-merge bits query (run-transcript.ts) */
async function threadPage(taskId: string, before?: { createdAt: Date; id: string }) {
  const window = await scanThreadWindow(taskId, before);
  const { pageRows, hasMore } = await pageFromWindow(taskId, window);

  const runIds = pageRows.flatMap((m) => (m.run ? [m.run.id] : []));
  // live output + has* flags for the page's runs (transcript text never rides);
  // THREAD BOUNDING LAW: the outputs scan is task-scoped (task_id predicate rides
  // task_attachments_task_idx) — never a cross-task table scan
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
            eq(taskAttachments.taskId, taskId),
            eq(taskAttachments.kind, 'output'),
            inArray(taskAttachments.runId, runIds),
          ),
        )
    : [];
  // run payload needs the same ISO + agent-name mapping the runs snapshot uses
  const employeeIds = [...new Set(pageRows.flatMap((m) => (m.run?.employeeId ? [m.run.employeeId] : [])))];
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

  const items = pageRows.map((m) => {
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
  return { items, hasMore };
}

/** newest page of the conversation thread ({items, hasMore} — THREAD BOUNDING LAW #175) */
export function listTaskThread(taskId: string) {
  return threadPage(taskId);
}

/** previous page on demand ({taskId, before} cursor = the oldest held item's
 * (createdAt,id) -> {items, hasMore} — THREAD BOUNDING LAW #175) */
export function threadOlderPage(taskId: string, before: { createdAt: string; id: string }) {
  return threadPage(taskId, { createdAt: new Date(before.createdAt), id: before.id });
}

// re-exported so callers of the old helper keep one import site
export { taskMessageActivities, taskMessages };
export { dropEchoNotes } from './echo-notes';
