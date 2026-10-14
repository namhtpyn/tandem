/**
 * Pure thread model for the Paperclip-style task detail page: merges description,
 * runs and activity into one chronologically ordered chat timeline.
 *
 * Kinds:
 *  - 'brief'    the task description rendered as the opening message bubble
 *  - 'run'      an agent dispatch turn (status pill + output bubble)
 *  - 'note'     human/system activity (questions, verdicts, status changes...)
 */
export interface ThreadBriefItem { kind: 'brief'; id: string; body: string; createdAt: string }
export interface ThreadRunItem {
  kind: 'run'
  id: string
  status: 'running' | 'done' | 'failed'
  exitCode: number | null
  output: string
  startedAt: string
  finishedAt: string | null
}
export interface ThreadNoteItem {
  kind: 'note'
  id: string
  noteKind: string
  body: string
  authorName: string | null
  createdAt: string
}
export type ThreadItem = ThreadBriefItem | ThreadRunItem | ThreadNoteItem

export interface ThreadSource {
  description?: string | null
  createdAt?: string | null
  runs?: Array<Pick<ThreadRunItem, 'id' | 'status' | 'output' | 'exitCode' | 'startedAt' | 'finishedAt'>>
  activity?: Array<Pick<ThreadNoteItem, 'id' | 'noteKind' | 'body' | 'authorName' | 'createdAt'>>
}

/** Envelope of the output contract: last [RESULT]/[QUESTION]/[BLOCKED] line wins. */
export type EnvelopeKind = 'result' | 'run' | 'question' | 'blocked'
export interface RunEnvelope { kind: EnvelopeKind; text: string }

export function parseRunEnvelope(output: string | null | undefined): RunEnvelope | null {
  if (!output) return null
  const lines = output.trimEnd().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(/^\[(RESULT|QUESTION|BLOCKED)\]\s*(.*)$/)
    if (m) return { kind: m[1]!.toLowerCase() as EnvelopeKind, text: m[2]!.trim() }
  }
  return null
}

/** Strip the envelope line from displayed output so the bubble shows prose only. */
export function runOutputWithoutEnvelope(output: string | null | undefined): string {
  const env = parseRunEnvelope(output)
  if (!env) return output ?? ''
  // parseRunEnvelope anchors on ^, so the uppercase token is always findable
  const idx = output!.trimEnd().lastIndexOf(`[${env.kind.toUpperCase()}]`)
  return output!.slice(0, idx).trim()
}

/** Compact thread time: same-day -> "14:32", older -> "Oct 12". No seconds, no date spam. */
export function formatThreadTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (sameDay) return hm
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const sameYear = d.getFullYear() === now.getFullYear()
  return sameYear ? `${months[d.getMonth()]} ${d.getDate()}, ${hm}` : `${months[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`
}

/** Merge by stable timestamp: runs by startedAt, notes by createdAt, brief first. */
export function buildThread(src: ThreadSource): ThreadItem[] {
  const items: ThreadItem[] = []
  if (src.description && src.description.trim()) {
    items.push({ kind: 'brief', id: 'brief', body: src.description, createdAt: src.createdAt ?? '' })
  }
  for (const r of src.runs ?? []) {
    items.push({ kind: 'run', id: r.id, status: r.status, exitCode: r.exitCode, output: r.output, startedAt: r.startedAt, finishedAt: r.finishedAt })
  }
  for (const a of src.activity ?? []) {
    items.push({ kind: 'note', id: a.id, noteKind: a.noteKind, body: a.body, authorName: a.authorName, createdAt: a.createdAt })
  }
  // brief first regardless of clock skew, then chronological by each item's own clock
  const timeOf = (t: ThreadItem): string => (t.kind === 'run' ? t.startedAt : t.createdAt)
  const briefFirst = (t: ThreadItem): number => (t.kind === 'brief' ? 0 : 1)
  items.sort((a, b) => briefFirst(a) - briefFirst(b) || timeOf(a).localeCompare(timeOf(b)) || a.id.localeCompare(b.id))
  return items
}
