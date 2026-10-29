import { z } from 'zod';

// Tandem's run-verdict contract, built on the generic structured-output module.
// The brief asks the agent to end its turn with a single JSON line
// {"kind": "result" | "question" | "blocked", "body": "..."}; parsing is
// zod-validated. No marker fallback: historical run outputs were migrated to
// the JSON shape by migration 20261017030000 (one-time DML), so the whole
// estate speaks one format.
import { PROPOSAL_KIND } from '#shared/enums';
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

// REVIEW verdict contract (owner spec 2026-10-29): the reviewer's vocabulary IS the
// verdict vocabulary — approved/rejected/request_change map identity onto
// task_reviews.status, and `escalate` is a REFERRAL that can never settle a round.
// Strict: legacy `result`/`blocked` kinds are NOT accepted (a review run emitting
// them reads as verdict-less and parks after one bounded re-dispatch).
export const ReviewVerdictSchema = z.object({
  kind: z.enum(['approved', 'rejected', 'request_change', 'escalate']),
  body: z.string().max(50_000),
});

export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
export type ReviewEnvelope = { kind: ReviewVerdict['kind']; text: string };

export type EnvelopeKind = RunVerdict['kind'];
export type RunEnvelope = {
  kind: EnvelopeKind;
  text: string;
  subtasks?: Array<{ title: string; description?: string; assigneeName?: string }>;
  reassign?: { assigneeName: string; reason?: string };
};

/** routing proposal shapes, derived from the verdict schema — the runner maps the
 * settled verdict envelope onto these ([SUBTASKS]/[REASSIGN] text markers are
 * RETIRED: routing rides the envelope JSON). Lives in #shared so the server
 * runner and the UI thread derive from ONE definition. */
export type SubtaskProposalItem = z.infer<typeof SubtaskProposalItemSchema>;
export type RoutingProposal =
  | { kind: typeof PROPOSAL_KIND.SUBTASKS; items: SubtaskProposalItem[] }
  | { kind: typeof PROPOSAL_KIND.REASSIGN; targetName: string; reason?: string };

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
  return parseVerdictOutput(output, RunVerdictSchema, (v) => toEnvelope(v as RunVerdict)) as RunEnvelope | null;
}

/** review-mode parse: same grammar, review vocabulary (strict — see ReviewVerdictSchema) */
export function parseReviewEnvelope(output: string | null | undefined): ReviewEnvelope | null {
  return parseVerdictOutput(output, ReviewVerdictSchema, (v) => ({
    kind: v.kind,
    text: v.body,
  })) as ReviewEnvelope | null;
}

/** the shared bottom-up scan; the schema is the ONLY vocabulary difference */
function parseVerdictOutput(
  output: string | null | undefined,
  schema: z.ZodType<{ kind: string; body: string }>,
  toEnv: (v: { kind: string; body: string }) => unknown,
): unknown {
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
        const parsed = schema.safeParse(JSON.parse(raw));
        if (parsed.success) return toEnv(parsed.data);
      } catch {
        /* not JSON — keep scanning */
      }
      continue;
    }
    // open object without a close on one line: GROW the block line by line until it
    // parses. Two real-world split shapes (task 01a182f2 deadlock, fixed 2026-10-29):
    //  - pretty-printed verdicts break between tokens -> '\n' join is legal whitespace
    //  - the 400-char force-flush splits ONE long line mid-token -> '' join rebuilds it
    // Telemetry lines ([context]/[tool]) may trail the verdict; neither join-to-end
    // nor single-shape joins parsed that real blocked reviewer verdict.
    for (let end = i + 2; end <= Math.min(lines.length, i + 200); end++) {
      const seg = lines.slice(i, end).filter((l) => !l.trim().startsWith('```'));
      for (const joiner of ['\n', '']) {
        const block = seg.join(joiner);
        if (!block.trim().endsWith('}')) continue; // not closed yet — keep growing
        try {
          const parsed = schema.safeParse(JSON.parse(block));
          if (parsed.success) return toEnv(parsed.data);
        } catch {
          /* keep growing */
        }
      }
    }
  }
  return null;
}
