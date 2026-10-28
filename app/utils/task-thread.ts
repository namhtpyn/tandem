/**
 * Pure thread model for the Paperclip-style task detail page: merges description,
 * runs and activity into one chronologically ordered chat timeline.
 *
 * Kinds:
 *  - 'brief'    the task description rendered as the opening message bubble
 *  - 'run'      an agent dispatch turn (status pill + output bubble)
 *  - 'note'     human/system activity (questions, verdicts, status changes...)
 */
export type ThreadBriefItem = {
  kind: 'brief';
  id: string;
  body: string;
  createdAt: string;
  /** task creator shown as the brief author */ authorName?: string | null;
  /** creator's user id — avatar lookup via /api/employees/:userId/avatar */ authorId?: string | null;
};
export type ThreadRunItem = {
  kind: 'run';
  id: string;
  /** real settled run status — consumers map it to labels/colors themselves */
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'timeout' | 'stopped';
  exitCode: number | null;
  output: string;
  /** the agent (employee) that ran this turn, for the chat bubble label */
  agentName?: string | null;
  /** the thread message's author — avatar lookup via /api/employees/:userId/avatar */
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
  noteKind: string;
  body: string;
  authorName: string | null;
  /** author's user id — avatar lookup via /api/employees/:userId/avatar */
  authorId?: string | null;
  createdAt: string;
};
export type ThreadItem = ThreadBriefItem | ThreadRunItem | ThreadNoteItem;

export type ThreadSource = {
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

/** Envelope of the output contract: last [RESULT]/[QUESTION]/[BLOCKED] line wins. */
export type EnvelopeKind = 'result' | 'run' | 'question' | 'blocked';
export type RunEnvelope = { kind: EnvelopeKind; text: string };

import { PROPOSAL_KIND } from '#shared/enums';
// verdict parsing lives in shared/run-verdict (zod schema, bottom-up scan) —
// re-exported here so the UI thread and the runner share one implementation.
// (the file's own EnvelopeKind/RunEnvelope below include the 'run' thread kind)
export { parseRunEnvelope, RunVerdictSchema } from '#shared/run-verdict';

/** routing proposal shapes — the runner maps the settled verdict envelope onto these
 * ([SUBTASKS]/[REASSIGN] text markers are RETIRED: routing rides the envelope JSON) */
export type SubtaskProposalItem = { title: string; description?: string; assigneeName?: string };
export type RoutingProposal =
  | { kind: typeof PROPOSAL_KIND.SUBTASKS; items: SubtaskProposalItem[] }
  | { kind: typeof PROPOSAL_KIND.REASSIGN; targetName: string; reason?: string };

/** Merge by stable timestamp: runs by startedAt, notes by createdAt, brief first. */
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
