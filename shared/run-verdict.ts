// Structured run verdicts: the brief asks the agent to end its turn with a
// single JSON line {"kind": "result" | "question" | "blocked", "body": "..."}.
// Parsing is zod-validated (schema lives here, shared by server and app); the
// legacy [RESULT]/[QUESTION]/[BLOCKED] markers remain a fallback so resumed
// sessions and older agents keep working.
import { z } from 'zod'

export const RunVerdictSchema = z.object({
  kind: z.enum(['result', 'question', 'blocked']),
  body: z.string().min(1),
})

export type RunVerdict = z.infer<typeof RunVerdictSchema>

export type EnvelopeKind = RunVerdict['kind']
export interface RunEnvelope { kind: EnvelopeKind, text: string }

/** try to parse a trailing JSON verdict line (bottom-up, fence-tolerant).
 * Returns null when the output has no structured verdict. */
export function parseStructuredVerdict(output: string | null | undefined): RunVerdict | null {
  if (!output) return null
  const lines = output.trimEnd().split('\n')
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    let raw = lines[i]!.trim()
    if (raw.startsWith('```')) raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
    if (!raw.startsWith('{') || !raw.endsWith('}')) continue
    try {
      const parsed = RunVerdictSchema.safeParse(JSON.parse(raw))
      if (parsed.success) return parsed.data
    }
    catch { /* not JSON — keep scanning */ }
  }
  return null
}

const MARKER_RE = /^\[(RESULT|QUESTION|BLOCKED)\]\s*(.*)$/

/** the one entry point used by the runner and the UI thread:
 * bottom-up scan — the LAST verdict-looking line wins, JSON or marker. */
export function parseRunEnvelope(output: string | null | undefined): RunEnvelope | null {
  if (!output) return null
  const lines = output.trimEnd().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]!.trim()
    const structured = parseStructuredVerdict(raw)
    if (structured) return { kind: structured.kind, text: structured.body }
    const m = raw.match(MARKER_RE)
    if (m) return { kind: m[1]!.toLowerCase() as EnvelopeKind, text: m[2]!.trim() }
  }
  return null
}
