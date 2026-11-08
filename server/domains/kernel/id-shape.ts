import { isUuid } from '#shared/utils/is-uuid';

import { ORPCError } from './kernel';

/**
 * ID-SHAPE LAW (SPEC "API law", #358): a uuid-typed id that is not in the
 * canonical 8-4-4-4-12 wire form can never name a row, and handing the raw
 * string to a uuid column makes Postgres raise 22P02 ('invalid input syntax
 * for type uuid') — a 500 instead of the specced answer. Every handler whose
 * input lands in a uuid column calls this BEFORE the query builder sees it.
 *
 * The outcome is per surface, never per call site:
 *   - reads / lookups: a malformed id is a miss → NOT_FOUND
 *   - writes: a malformed id is malformed input → BAD_REQUEST (never a claim
 *     that a row is missing)
 *   - list filters short-circuit to the specced empty page instead of calling
 *     this at all (a filter is not a lookup)
 */
export function requireUuid(id: string, code: 'NOT_FOUND' | 'BAD_REQUEST', message: string): void {
  if (!isUuid(id)) throw new ORPCError(code, { message });
}
