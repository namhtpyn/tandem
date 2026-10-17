// Tandem's run-verdict contract, built on the generic structured-output module.
// The brief asks the agent to end its turn with a single JSON line
// {"kind": "result" | "question" | "blocked", "body": "..."}; parsing is
// zod-validated. No marker fallback: historical run outputs were migrated to
// the JSON shape by migration 20261017030000 (one-time DML), so the whole
// estate speaks one format.
import { z } from 'zod'

export const RunVerdictSchema = z.object({
  kind: z.enum(['result', 'question', 'blocked']),
  body: z.string(), // empty allowed — the runner substitutes fallback text per kind
})

export type RunVerdict = z.infer<typeof RunVerdictSchema>

export type EnvelopeKind = RunVerdict['kind']
export interface RunEnvelope { kind: EnvelopeKind, text: string }

/**
 * The single verdict parser — used by the runner AND the UI thread. SYNC
 * (safeParse): RunVerdictSchema carries no async refinements, so safeParse is
 * exact; the UI needs a sync call in computed/template context. Schemas WITH
 * async refinements belong to the generic module (parseStructuredOutput,
 * safeParseAsync) used by the ACP client.
 * Bottom-up scan, fence-tolerant, bounded window (a verdict is the turn end).
 * Accepts a full output or a single line; null when no valid verdict.
 */
export function parseRunEnvelope(output: string | null | undefined): RunEnvelope | null {
  if (!output) return null
  const lines = output.trimEnd().split('\n')
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 40); i--) {
    let raw = lines[i]!.trim()
    if (raw.startsWith('```')) raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
    if (!raw.startsWith('{') || !raw.endsWith('}')) continue
    try {
      const parsed = RunVerdictSchema.safeParse(JSON.parse(raw))
      if (parsed.success) return { kind: parsed.data.kind, text: parsed.data.body }
    }
    catch { /* not JSON — keep scanning */ }
  }
  return null
}
