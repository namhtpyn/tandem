// Canonical uuid shape (any version). A uuid-typed query value that is not
// this shape can never name a row: handed to Postgres it raises 22P02
// ('invalid input syntax for type uuid') and surfaces as a 500. Shape-check it
// at the edge — a malformed id is a miss (empty page for filters, NOT_FOUND for
// lookups), never a query error.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
