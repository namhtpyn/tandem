// TEXT-STORABILITY LAW (SPEC "API law", #377/#382): Postgres text columns
// cannot store a NUL byte or an unpaired surrogate. A NUL throws at the driver
// (invalid byte sequence -> an opaque 500); an unpaired surrogate is silently
// rewritten to U+FFFD (stored corruption). Callers refuse such text at their
// schema edge; this module is the ONE implementation of "unstorable".

import { z } from 'zod';

/** true when `value` carries text a Postgres text column cannot store: NUL or an unpaired surrogate */
export function hasUnstorableText(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1; // a valid surrogate pair (astral character) is storable
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true; // low surrogate with no high before it
    }
  }
  return false;
}

/** the field-named refusal every surface answers (BAD_REQUEST through oRPC) */
export function unstorableMessage(field: string): string {
  return `${field} contains invalid characters (NUL or a lone surrogate)`;
}

/**
 * Append the TEXT-STORABILITY refusal to ANY input schema whose parsed output
 * may be a string — a bare field, a `.nullable()`/`.optional()` one, or a
 * `.default()`/`.trim()` chain. The schema keeps its own shape rules (min, max,
 * trim, default); this only adds the storability refusal. Non-string outputs
 * (null / undefined) pass through.
 */
export function storable<S extends z.ZodTypeAny>(field: string, schema: S): S {
  return schema.refine(
    (value: unknown) => typeof value !== 'string' || !hasUnstorableText(value),
    unstorableMessage(field),
  );
}

/** non-blank, storable text — an omitted `max` keeps an already-uncapped field uncapped (text-typed ids) */
export function storableText(field: string, max?: number) {
  const base = z.string().min(1);
  return storable(field, max === undefined ? base : base.max(max));
}

/** blank = nothing but whitespace / default-ignorable code points (ZWSP, ZWNJ,
 *  ZWJ, word joiner, BOM, format chars) — a blank id trims into a NEW row at
 *  the upsert-by-id writes and can never name one */
const BLANK_ID = /^[\s\p{Default_Ignorable_Code_Point}]*$/u;

/** a padding code point at an id's edge: whitespace, or a default-ignorable
 *  that is NOT grapheme-extending (VS16 / ZWJ legally continue the preceding
 *  character, so `x❤️` is an exact id, not a padded one) */
function padCodePoint(ch: string): boolean {
  if (/\s/u.test(ch)) return true;
  if (!/[\p{Default_Ignorable_Code_Point}]/u.test(ch)) return false;
  return !/[\p{Grapheme_Extend}\u200d]/u.test(ch);
}

function hasPadEdge(value: string): boolean {
  const points = [...value];
  if (points.length === 0) return false;
  return padCodePoint(points[0] as string) || padCodePoint(points[points.length - 1] as string);
}

/** a text-typed id parameter (write target, store key): non-blank, unpadded,
 *  storable. Never a new-row mint, never a silent rewrite. */
export function storableId(field: string, max?: number) {
  const base = max === undefined ? z.string() : z.string().max(max);
  return storable(
    field,
    base
      .refine((value) => !BLANK_ID.test(value), `${field} must not be blank`)
      .refine((value) => !hasPadEdge(value), `${field} must not be padded with whitespace`),
  );
}

/** a READ key / list filter: refuses unstorable text and a blank id, but a
 *  padded value stays an ordinary miss (SPEC: a filter is not a lookup) */
export function storableIdRef(field: string, max?: number) {
  const base = max === undefined ? z.string() : z.string().max(max);
  return storable(
    field,
    base.refine((value) => !BLANK_ID.test(value), `${field} must not be blank`),
  );
}

/** storable text for optional/nullable fields — callers add `.nullable().optional()` */
export function storableOptionalText(field: string, max: number) {
  return storable(field, z.string().max(max));
}
