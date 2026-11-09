// ACCESS-KEY NAME CAP (#367, SPEC "Roles & access"): better-auth's api-key
// plugin caps key names at 32 chars and throws INVALID_NAME_LENGTH — an
// APIError oRPC cannot map, so a legal employee create (name > 21 chars busts
// `"<name> access key"`) answered 500. Derived names truncate the base, never
// the fixed suffix; caller-supplied names over the cap are BAD_REQUEST.
import { describe, expect, it } from 'vitest';

import {
  ACCESS_KEY_NAME_MAX,
  assertAccessKeyName,
  derivedAccessKeyName,
} from '../../server/domains/employees/access-key-name';

const SUFFIX = ' access key';

describe('derivedAccessKeyName — the minted default always fits the plugin cap', () => {
  it('truncates the base, never the suffix (100-char employee name)', () => {
    const name = derivedAccessKeyName('N'.repeat(100), SUFFIX);
    expect(name.length).toBe(ACCESS_KEY_NAME_MAX);
    expect(name.endsWith(SUFFIX)).toBe(true);
    expect(name).toBe(`${'N'.repeat(ACCESS_KEY_NAME_MAX - SUFFIX.length)}${SUFFIX}`);
  });

  it('fits the shorter ` key` suffix too', () => {
    const name = derivedAccessKeyName('N'.repeat(100), ' key');
    expect(name.length).toBe(ACCESS_KEY_NAME_MAX);
    expect(name.endsWith(' key')).toBe(true);
  });

  it('passes a short base through unchanged', () => {
    expect(derivedAccessKeyName('Ada', SUFFIX)).toBe('Ada access key');
    expect(derivedAccessKeyName('Ada', ' key')).toBe('Ada key');
  });

  it('the cap boundary is exact — a name that already fits is not truncated', () => {
    const base = 'B'.repeat(ACCESS_KEY_NAME_MAX - SUFFIX.length);
    expect(derivedAccessKeyName(base, SUFFIX)).toBe(`${base}${SUFFIX}`);
    expect(derivedAccessKeyName(base, SUFFIX).length).toBe(ACCESS_KEY_NAME_MAX);
  });
});

describe('assertAccessKeyName — caller-supplied names over the cap are the specced BAD_REQUEST', () => {
  it('trims a supplied name', () => {
    expect(assertAccessKeyName('  primary key  ')).toBe('primary key');
  });

  it('accepts a name exactly at the cap', () => {
    const name = 'K'.repeat(ACCESS_KEY_NAME_MAX);
    expect(assertAccessKeyName(name)).toBe(name);
  });

  it('rejects one char over the cap with BAD_REQUEST / name too long — never a plugin 500', () => {
    expect(() => assertAccessKeyName('K'.repeat(ACCESS_KEY_NAME_MAX + 1))).toThrowError(
      expect.objectContaining({ code: 'BAD_REQUEST', message: expect.stringContaining('name too long') }),
    );
  });

  it('whitespace-only is empty after trim — the handlers own the blank path', () => {
    expect(assertAccessKeyName('   ')).toBe('');
  });
});
