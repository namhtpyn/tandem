// Access-key name cap (SPEC "Roles & access", ACCESS-KEY NAME CAP).
// better-auth's api-key plugin defaults `maximumNameLength` to 32 and throws
// INVALID_NAME_LENGTH — an APIError the oRPC layer cannot map, so it surfaced
// as INTERNAL_SERVER_ERROR (500) on legal input: an employee name > 21 chars
// busts `"<name> access key"`, and a caller-supplied key name > 32 busts the
// plugin directly. Derived names fit the cap; caller names over it are the
// specced BAD_REQUEST.

import { ORPCError } from '../kernel/kernel';

/** better-auth api-key plugin default `maximumNameLength` */
export const ACCESS_KEY_NAME_MAX = 32;

/** `<base><suffix>` capped to ACCESS_KEY_NAME_MAX — the suffix is fixed, the base truncates */
export function derivedAccessKeyName(base: string, suffix: string): string {
  const room = Math.max(ACCESS_KEY_NAME_MAX - suffix.length, 0);
  return `${base.slice(0, room)}${suffix}`;
}

/** caller-supplied names are trimmed and capped — over the cap is BAD_REQUEST, never the plugin's 500 */
export function assertAccessKeyName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length > ACCESS_KEY_NAME_MAX) {
    throw new ORPCError('BAD_REQUEST', {
      message: `name too long — access-key names are capped at ${ACCESS_KEY_NAME_MAX} characters`,
    });
  }
  return trimmed;
}
