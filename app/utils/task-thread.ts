/**
 * Pure thread model for the Paperclip-style task detail page: merges description,
 * runs and activity into one chronologically ordered chat timeline.
 *
 * Kinds:
 *  - 'brief'    the task description rendered as the opening message bubble
 *  - 'run'      an agent dispatch turn (status pill + output bubble)
 *  - 'note'     human/system activity (questions, verdicts, status changes...)
 */
import { ACTIVITY_KIND, type ActivityKind } from '#shared/enums';

type ThreadBriefItem = {
  kind: 'brief';
  id: string;
  body: string;
  createdAt: string;
  /** task creator shown as the brief author */ authorName?: string | null;
  /** creator's user id — avatar lookup via employeeAvatarUrl() */ authorId?: string | null;
};
type ThreadRunItem = {
  kind: 'run';
  id: string;
  /** real settled run status — consumers map it to labels/colors themselves */
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'timeout' | 'stopped';
  exitCode: number | null;
  /** executions of this dispatch intent (run-level retries replay the same row) */
  attempts?: number;
  output: string;
  /** the agent (employee) that ran this turn, for the chat bubble label */
  agentName?: string | null;
  /** the thread message's author — avatar lookup via employeeAvatarUrl() */
  authorId?: string | null;
  authorName?: string | null;
  /** the exact prompt (brief) sent for this turn, when recorded */
  prompt?: string | null;
  /** the parsed result the settle wrote onto the thread message */
  body?: string | null;
  startedAt: string;
  finishedAt: string | null;
};
export type ThreadNoteItem = {
  kind: 'note';
  id: string;
  /** typed activity kind — producers narrow through activityNotes(), never a raw string */
  noteKind: ActivityKind;
  body: string;
  authorName: string | null;
  /** author's user id — avatar lookup via employeeAvatarUrl() */
  authorId?: string | null;
  createdAt: string;
};
export type ThreadItem = ThreadBriefItem | ThreadRunItem | ThreadNoteItem;

type ThreadSource = {
  description?: string | null;
  createdAt?: string | null;
  briefAuthorName?: string | null;
  briefAuthorId?: string | null;
  runs?: Array<
    Pick<
      ThreadRunItem,
      | 'id'
      | 'status'
      | 'output'
      | 'exitCode'
      | 'attempts'
      | 'prompt'
      | 'body'
      | 'agentName'
      | 'authorId'
      | 'authorName'
      | 'startedAt'
      | 'finishedAt'
    >
  >;
  activity?: Array<Pick<ThreadNoteItem, 'id' | 'noteKind' | 'body' | 'authorName' | 'authorId' | 'createdAt'>>;
};

// verdict parsing lives in shared/run-verdict (zod schema, bottom-up scan) —
// re-exported here so the UI thread and the runner share one implementation.
// (the UI never parses envelopes directly: item.kind === 'run' items carry the
// settled body, and parseRunEnvelope is only the pre-settle fallback)
export { parseRunEnvelope } from '#shared/run-verdict';

/** activity payload kind (jsonb arrives loose) → typed ActivityKind, null when absent/unknown.
 * The ONE narrowing point: legacy SCREAMING/lowercase rows normalize here so no
 * producer has to carry String()/toUpperCase() compensation. */
export function noteKindOf(activity: Record<string, unknown> | null | undefined): ActivityKind | null {
  const raw = activity?.kind;
  if (typeof raw !== 'string' || !raw) return null;
  const upper = raw.toUpperCase();
  return (Object.values(ACTIVITY_KIND) as string[]).includes(upper) ? (upper as ActivityKind) : null;
}

type ActivityRowLike = Pick<ThreadNoteItem, 'id' | 'body' | 'authorName' | 'authorId' | 'createdAt'> & {
  activity: Record<string, unknown> | null;
};

/** thread rows → typed activity items for buildThread (runs-only surfaces pass []) */
export function activityNotes(
  rows: readonly ActivityRowLike[],
): Array<Pick<ThreadNoteItem, 'id' | 'noteKind' | 'body' | 'authorName' | 'authorId' | 'createdAt'>> {
  return rows.flatMap((r) => {
    const noteKind = noteKindOf(r.activity);
    if (!noteKind) return [];
    return [
      { id: r.id, noteKind, body: r.body, authorName: r.authorName, authorId: r.authorId, createdAt: r.createdAt },
    ];
  });
}

/** Merge by stable timestamp: runs by startedAt, notes by createdAt, brief first. */
/** display timestamp for any thread item (runs carry startedAt, others createdAt) */
export function threadTime(t: ThreadItem): string | null {
  return t.kind === 'run' ? (t.startedAt ?? null) : (t.createdAt ?? null);
}

export function buildThread(src: ThreadSource): ThreadItem[] {
  const items: ThreadItem[] = [];
  if (src.description && src.description.trim()) {
    items.push({
      kind: 'brief',
      id: 'brief',
      body: src.description,
      createdAt: src.createdAt ?? '',
      authorName: src.briefAuthorName ?? null,
      authorId: src.briefAuthorId ?? null,
    });
  }
  for (const r of src.runs ?? []) {
    items.push({
      kind: 'run',
      id: r.id,
      status: r.status,
      exitCode: r.exitCode,
      attempts: r.attempts ?? 1,
      output: r.output,
      prompt: r.prompt,
      body: r.body,
      agentName: r.agentName,
      authorId: r.authorId ?? null,
      authorName: r.authorName ?? null,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    });
  }
  for (const a of src.activity ?? []) {
    items.push({
      kind: 'note',
      id: a.id,
      noteKind: a.noteKind,
      body: a.body,
      authorName: a.authorName,
      authorId: a.authorId,
      createdAt: a.createdAt,
    });
  }
  // brief first regardless of clock skew, then chronological by each item's own clock
  const timeOf = (t: ThreadItem) => (t.kind === 'run' ? t.startedAt : t.createdAt);
  const briefFirst = (t: ThreadItem) => (t.kind === 'brief' ? 0 : 1);
  items.sort((a, b) => briefFirst(a) - briefFirst(b) || timeOf(a).localeCompare(timeOf(b)) || a.id.localeCompare(b.id));
  return items;
}
