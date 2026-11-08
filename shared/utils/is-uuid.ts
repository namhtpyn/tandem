// Canonical uuid shape — the ONLY spelling the API accepts for a uuid-typed id.
// Ids cross the wire in 8-4-4-4-12 form (either case). Postgres would also read
// braced / hyphenless / 4-digit-group spellings, but those are outside the
// contract: they are treated as misses, never silently normalized. The check
// exists because handing any other string to a uuid column raises 22P02
// ('invalid input syntax for type uuid') and surfaces as a 500.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
