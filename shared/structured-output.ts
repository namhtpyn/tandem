// Generic structured output over ACP turns — application-agnostic.
// Any zod schema can be turned into (a) the output-contract instruction appended
// to an ACP prompt and (b) a parser for the agent's trailing JSON line.
// The agent side is prompt + parse (ACP carries plain text); the zod schema is
// the single source of truth for both the instruction and the validation.
import { z } from 'zod';

export type OutputContractOptions = {
  /** replaces the default intro line */
  intro?: string;
  /** concrete example lines shown to the agent (strongly recommended — agents
   *  follow examples better than bare JSON Schema) */
  examples?: string[];
  /** trailing note (e.g. legacy-fallback notice) */
  outro?: string;
};

/** Render the output-contract instruction for a zod schema (JSON Schema form). */
export function renderOutputContract<T extends z.ZodType>(schema: T, opts: OutputContractOptions = {}): string {
  const json = JSON.stringify(z.toJSONSchema(schema));
  const lines: string[] = [];
  lines.push(
    opts.intro ??
      `OUTPUT CONTRACT — end your response with exactly one JSON line (no code fence) validating against this JSON Schema:`,
  );
  lines.push(json);
  if (opts.examples?.length) {
    lines.push('Exactly like one of these examples:');
    for (const ex of opts.examples) lines.push(ex);
  }
  if (opts.outro) lines.push(opts.outro);
  return lines.join('\n');
}

/**
 * Parse the agent's trailing JSON against a zod schema — ASYNC (safeParseAsync),
 * so schemas with async refinements/superRefines validate fully.
 * Bottom-up scan (last matching line wins), fence-tolerant, bounded window —
 * a structured answer is expected at the very end of the turn.
 * Returns the parsed value or null (no valid structured output found).
 */
export async function parseStructuredOutput<T extends z.ZodType>(
  output: string | null | undefined,
  schema: T,
  window = 40,
): Promise<z.infer<T> | null> {
  if (!output) return null;
  const lines = output.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - window); i--) {
    let raw = lines[i]!.trim();
    if (raw.startsWith('```'))
      raw = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, '')
        .trim();
    if (!raw.startsWith('{') || !raw.endsWith('}')) continue;
    try {
      const parsed = await schema.safeParseAsync(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      /* not JSON — keep scanning */
    }
  }
  return null;
}
