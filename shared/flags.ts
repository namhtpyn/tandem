/**
 * Feature flags — the settings-backed runtime flag namespace (#111).
 *
 * Contract (SPEC.md, Settings > Feature flags): one settings key `flags`
 * stores a JSON object `{ "<name>": boolean }`; a flags write REPLACES the
 * stored map. Reads are tolerant and FAIL CLOSED: a missing key, unparsable
 * JSON, a non-object payload, invalid names or a map over the cap all read
 * as NO flags — every flag is OFF unless explicitly true, and an
 * unrecognized flag name is simply off. Pure module: no db, no clock.
 */

/** Flag-name grammar (SPEC): one lowercase letter first, then lowercase
 * letters/digits/dots/dashes/underscores, 40 chars max. */
export const FLAG_NAME_RE = /^[a-z][a-z0-9_.-]{0,39}$/;

/** Stored-map cap: an object with more keys than this reads as NO flags. */
export const MAX_FLAGS = 20;

/** Shared strict map parse: a valid flags object returns its entries map,
 * anything unusable (wrong shape, bad name, non-boolean value, over the cap)
 * returns null. parseFlags and isValidFlagsPayload both build on this so they
 * can never disagree about what is valid. */
function parseFlagsMap(v: unknown): Record<string, boolean> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > MAX_FLAGS) return null;
  for (const [name, value] of entries) {
    if (!FLAG_NAME_RE.test(name) || typeof value !== 'boolean') return null;
  }
  return Object.fromEntries(entries) as Record<string, boolean>;
}

/** Tolerant, fail-closed flags reader: any invalid input shape yields an
 * empty map (all flags off) — never a partial map, never a throw. */
export function parseFlags(raw: string | null): Record<string, boolean> {
  if (raw === null) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return {};
  }
  return parseFlagsMap(v) ?? {};
}

/** Strict validity check: true iff raw is a payload the flags write path
 * could have stored (a missing key — null — is not corruption). Where
 * parseFlags fails closed (any invalid payload reads as {}), this
 * DISTINGUISHES invalid from empty: the settings integrity auditor needs the
 * difference (SPEC: Health — settings integrity). */
export function isValidFlagsPayload(raw: string | null): boolean {
  if (raw === null) return true;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return false;
  }
  return parseFlagsMap(v) !== null;
}

/** First flagged feature (SPEC): run turns in the task thread render their
 * wall-clock duration when this flag is on. */
export const FLAG_TASKS_TURN_DURATIONS = 'tasks.turn-durations';
