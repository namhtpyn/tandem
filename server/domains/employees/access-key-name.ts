// Access-key name cap (SPEC "Roles & access", ACCESS-KEY NAME CAP).
// better-auth's api-key plugin defaults `maximumNameLength` to 32 and throws
// INVALID_NAME_LENGTH — an APIError the oRPC layer cannot map, so it surfaced
// as INTERNAL_SERVER_ERROR (500) on legal input: an employee name > 21 chars
// busts `"<name> access key"`, and a caller-supplied key name > 32 busts the
// plugin directly. Derived names fit the cap (truncating on a CODE-POINT
// boundary — cutting a UTF-16 surrogate pair would store a lone surrogate and
// silently corrupt the name); caller names over it are the specced BAD_REQUEST.

import { hasUnstorableText } from '#shared/utils/storable-text';

import { ORPCError } from '../kernel/kernel';

/** better-auth api-key plugin default `maximumNameLength` — its check is `name.length` (UTF-16 code units) */
export const ACCESS_KEY_NAME_MAX = 32;

/** `<base><suffix>` capped to ACCESS_KEY_NAME_MAX — the suffix is fixed, the base truncates */
export function derivedAccessKeyName(base: string, suffix: string): string {
  if (suffix.length > ACCESS_KEY_NAME_MAX) {
    // fail closed: a suffix over the whole cap would mint an over-cap name (the very 500 this module prevents)
    throw new Error(`access-key suffix is longer than the name cap: "${suffix}"`);
  }
  const room = ACCESS_KEY_NAME_MAX - suffix.length;
  let prefix = '';
  for (const char of base) {
    // array iteration is by code point; an astral char is 2 UTF-16 units and never split.
    // NUL and lone surrogates cannot be stored — drop them rather than write an ill-formed name
    const code = char.charCodeAt(0);
    if (code === 0 || (char.length === 1 && code >= 0xd800 && code <= 0xdfff)) continue;
    if (prefix.length + char.length > room) break;
    prefix += char;
  }
  return `${prefix}${suffix}`;
}

/** caller-supplied names are trimmed, validated and capped (the backend's `name.length` measure) — over the cap is BAD_REQUEST, never the plugin's 500 */
export function assertAccessKeyName(name: string): string {
  const trimmed = name.trim();
  if (hasUnstorableText(trimmed)) {
    throw new ORPCError('BAD_REQUEST', {
      message: 'name contains invalid characters (NUL or a lone surrogate)',
    });
  }
  if (trimmed.length > ACCESS_KEY_NAME_MAX) {
    throw new ORPCError('BAD_REQUEST', {
      message: `name too long — access-key names are capped at ${ACCESS_KEY_NAME_MAX} characters (UTF-16 code units)`,
    });
  }
  return trimmed;
}
