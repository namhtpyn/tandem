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
  // empty allowed — the runner substitutes fallback text per kind; .max bounds the one
  // unbounded agent input (human notes cap at 10k elsewhere)
  body: z.string().max(50_000),
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

/** schema verdict -> shared envelope shape (one mapping site for every parse path) */
const toEnvelope = (v: RunVerdict): RunEnvelope => ({
  kind: v.kind,
  text: v.body,
  subtasks: v.subtasks,
  reassign: v.reassign,
});

/**
 * The single verdict parser — used by the runner AND the UI thread. SYNC
 * (safeParse): RunVerdictSchema carries no async refinements, so safeParse is
 * exact; the UI needs a sync call in computed/template context. Schemas WITH
 * async refinements belong to the generic module (parseStructuredOutput,
 * safeParseAsync) used by the ACP client.
 * Bottom-up scan, fence-tolerant, bounded window (a verdict is the turn end).
 * Accepts a full output or a single line; null when no valid verdict.
 * Multi-line recovery: a pretty-printed verdict spans lines, so when a line starts
 * a JSON object it can't close, the block from that '{' to the turn end is joined
 * and parsed once before the scan moves on.
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
    if (!raw.startsWith('{')) continue;
    if (raw.endsWith('}')) {
      try {
        const parsed = RunVerdictSchema.safeParse(JSON.parse(raw));
        if (parsed.success) return toEnvelope(parsed.data);
      } catch {
        /* not JSON — keep scanning */
      }
      continue;
    }
    // open object without a close on one line: join the trailing block (fence
    // lines dropped) and parse once — bottom-up order still wins the match
    try {
      const block = lines
        .slice(i)
        .filter((l) => !l.trim().startsWith('```'))
        .join('\n');
      const parsed = RunVerdictSchema.safeParse(JSON.parse(block));
      if (parsed.success) return toEnvelope(parsed.data);
    } catch {
      /* not JSON — keep scanning */
    }
  }
  return null;
}
