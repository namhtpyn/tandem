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
  status: 'running' | 'done' | 'failed';
  exitCode: number | null;
  output: string;
  /** the agent (employee) that ran this turn, for the chat bubble label */
  agentName?: string | null;
  /** the exact prompt (brief) sent for this turn, when recorded */
  prompt?: string | null;
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
    Pick<ThreadRunItem, 'id' | 'status' | 'output' | 'exitCode' | 'prompt' | 'agentName' | 'startedAt' | 'finishedAt'>
  >;
  activity?: Array<Pick<ThreadNoteItem, 'id' | 'noteKind' | 'body' | 'authorName' | 'authorId' | 'createdAt'>>;
};

/** Envelope of the output contract: last [RESULT]/[QUESTION]/[BLOCKED] line wins. */
export type EnvelopeKind = 'result' | 'run' | 'question' | 'blocked';
export type RunEnvelope = { kind: EnvelopeKind; text: string };

// verdict parsing lives in shared/run-verdict (zod schema + marker fallback) —
// re-exported here so the UI thread and the runner share one implementation.
// (the file's own EnvelopeKind/RunEnvelope below include the 'run' thread kind)
import { parseRunEnvelope } from '#shared/run-verdict';
export { parseRunEnvelope, RunVerdictSchema } from '#shared/run-verdict';

/** Parse routing proposals from run output (structural markers, scanned anywhere):
 *  [SUBTASKS] title :: description :: assignee | title2 :: ...
 *  [REASSIGN] Employee Name — reason
 * These are proposals only — the confirm flow (human/decision model) executes them. */
export type SubtaskProposalItem = { title: string; description?: string; assigneeName?: string };
export type RoutingProposal =
  | { kind: 'subtasks'; items: SubtaskProposalItem[] }
  | { kind: 'reassign'; targetName: string; reason?: string };

export function parseRoutingProposals(output: string | null | undefined): RoutingProposal[] {
  if (!output) return [];
  const out: RoutingProposal[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    const st = line.match(/^\[SUBTASKS\]\s*(.+)$/);
    if (st) {
      const items: SubtaskProposalItem[] = st[1]!
        .split('|')
        .map((part) => {
          const seg = part.split('::').map((p) => p.trim());
          return { title: seg[0]!.slice(0, 200), description: seg[1] || undefined, assigneeName: seg[2] || undefined };
        })
        .filter((i) => i.title.length > 0);
      if (items.length) out.push({ kind: 'subtasks', items });
      continue;
    }
    const re = line.match(/^\[REASSIGN\]\s*(.+)$/);
    if (re) {
      const m = re[1]!.split(/\s+—\s+|\s+--\s+/);
      const targetName = m[0]!.trim(); // the marker regex guarantees non-empty here
      out.push({ kind: 'reassign', targetName, reason: m[1]?.trim() });
    }
  }
  return out;
}

/** Strip the JSON verdict line from displayed output so the bubble shows prose only. */
export function runOutputWithoutEnvelope(output: string | null | undefined): string {
  if (!output) return '';
  const lines = output.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (parseRunEnvelope(lines[i]!.trim())) {
      let end = i;
      // drop the fence opener left dangling above a fenced JSON verdict
      if (i > 0 && lines[i - 1]!.trim().startsWith('```')) end = i - 1;
      return lines.slice(0, end).join('\n').trim();
    }
  }
  return output;
}

/** Compact thread time: same-day -> "14:32", older -> "Oct 12". No seconds, no date spam. */
export function formatThreadTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return hm;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear
    ? `${months[d.getMonth()]} ${d.getDate()}, ${hm}`
    : `${months[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
}

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
      agentName: r.agentName,
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
  const timeOf = (t: ThreadItem): string => (t.kind === 'run' ? t.startedAt : t.createdAt);
  const briefFirst = (t: ThreadItem): number => (t.kind === 'brief' ? 0 : 1);
  items.sort((a, b) => briefFirst(a) - briefFirst(b) || timeOf(a).localeCompare(timeOf(b)) || a.id.localeCompare(b.id));
  return items;
}
