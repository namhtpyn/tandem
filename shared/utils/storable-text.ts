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

/** characters that render as nothing — a whitespace-only id is the same
 *  create-a-row hazard as '' at the two upsert-by-id writes (they trim) */
const BLANK_ID = /^[\s\u200b\u180e\u2060\ufeff]*$/;

/** a text-typed id parameter (read key, write target, store key or filter):
 *  a non-blank, unpadded, storable string. Blank/invisible-only ids are refused
 *  because the upsert-by-id writes trim them into a NEW row, and a padded id
 *  misses its own row in a JS set compare (the store-key writes mint a fresh
 *  id when the compare misses). */
export function storableId(field: string, max?: number) {
  const base = max === undefined ? z.string() : z.string().max(max);
  return storable(
    field,
    base
      .refine((value) => !BLANK_ID.test(value), `${field} must not be blank`)
      .refine((value) => value === value.trim(), `${field} must not be padded with whitespace`),
  );
}

/** storable text for optional/nullable fields — callers add `.nullable().optional()` */
export function storableOptionalText(field: string, max: number) {
  return storable(field, z.string().max(max));
}
