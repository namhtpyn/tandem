import { z } from 'zod';

// Tandem's run-verdict contract, built on the generic structured-output module.
// The brief asks the agent to end its turn with a single JSON line
// {"kind": "result" | "question" | "blocked", "body": "..."}; parsing is
// zod-validated. No marker fallback: historical run outputs were migrated to
// the JSON shape by migration 20261017030000 (one-time DML), so the whole
// estate speaks one format.
import { nonNull } from '#shared/utils/non-null';

export const SubtaskProposalItemSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  assigneeName: z.string().optional(),
});

export const RunVerdictSchema = z.object({
  kind: z.enum(['result', 'question', 'blocked']),
  body: z.string(), // empty allowed — the runner substitutes fallback text per kind
  // routing folded into the envelope (owner ruling 2026-10-26): the agent's single
  // JSON line carries its own routing proposals — no side-channel text markers
  subtasks: z.array(SubtaskProposalItemSchema).max(20).optional(),
  reassign: z.object({ assigneeName: z.string().min(1), reason: z.string().optional() }).optional(),
});

export type RunVerdict = z.infer<typeof RunVerdictSchema>;

export type EnvelopeKind = RunVerdict['kind'];
export type RunEnvelope = {
  kind: EnvelopeKind;
  text: string;
  subtasks?: Array<{ title: string; description?: string; assigneeName?: string }>;
  reassign?: { assigneeName: string; reason?: string };
};

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
  if (!output) return null;
  const lines = output.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 40); i--) {
    let raw = nonNull(lines[i]).trim();
    if (raw.startsWith('```'))
      raw = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, '')
        .trim();
    if (!raw.startsWith('{') || !raw.endsWith('}')) continue;
    try {
      const parsed = RunVerdictSchema.safeParse(JSON.parse(raw));
      if (parsed.success)
        return {
          kind: parsed.data.kind,
          text: parsed.data.body,
          subtasks: parsed.data.subtasks,
          reassign: parsed.data.reassign,
        };
    } catch {
      /* not JSON — keep scanning */
    }
  }
  return null;
}
