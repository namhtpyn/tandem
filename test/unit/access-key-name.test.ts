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

  it('never cuts through a surrogate pair — an astral char at the cut is dropped whole, the name stays well-formed', () => {
    // 20 ASCII units + 2-unit emoji: the emoji straddles the 21-unit room of ` access key`
    const name = derivedAccessKeyName(`${'A'.repeat(20)}🚀${'B'.repeat(10)}`, SUFFIX);
    expect(name.isWellFormed()).toBe(true);
    expect(name).toBe(`${'A'.repeat(20)}${SUFFIX}`);
    expect(name.length).toBeLessThanOrEqual(ACCESS_KEY_NAME_MAX);
    // ...and a code point that FITS before the boundary survives whole (not dropped)
    expect(derivedAccessKeyName(`${'A'.repeat(19)}🚀${'B'.repeat(10)}`, SUFFIX)).toBe(`${'A'.repeat(19)}🚀${SUFFIX}`);
    // every room boundary around an astral char stays well-formed, within the cap, and keeps every fitting prefix char
    for (let ascii = 0; ascii <= 21; ascii += 1) {
      const derived = derivedAccessKeyName(`${'A'.repeat(ascii)}🚀${'B'.repeat(10)}`, SUFFIX);
      expect(derived.isWellFormed()).toBe(true);
      expect(derived.length).toBeLessThanOrEqual(ACCESS_KEY_NAME_MAX);
      expect(derived.endsWith(SUFFIX)).toBe(true);
      expect(derived.startsWith('A'.repeat(ascii))).toBe(true);
    }
  });

  it('drops lone surrogates — a derived name is always well-formed, never an invalid UTF-8 insert', () => {
    const name = derivedAccessKeyName(`AB\uD83DCD`, SUFFIX);
    expect(name.isWellFormed()).toBe(true);
    expect(name).toBe(`ABCD${SUFFIX}`);
  });

  it('the cap boundary on the suffix is inclusive — a 32-unit suffix is itself the name; only over-cap suffixes fail closed', () => {
    expect(derivedAccessKeyName('x', 'y'.repeat(31))).toBe(`x${'y'.repeat(31)}`);
    expect(derivedAccessKeyName('x', 'y'.repeat(ACCESS_KEY_NAME_MAX))).toBe('y'.repeat(ACCESS_KEY_NAME_MAX));
    expect(() => derivedAccessKeyName('x', 'y'.repeat(ACCESS_KEY_NAME_MAX + 1))).toThrowError(
      /longer than the name cap/,
    );
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
      expect.objectContaining({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('name too long'),
      }),
    );
  });

  it('states the measure in its message — 32 characters means UTF-16 code units', () => {
    let message = '';
    try {
      assertAccessKeyName('😀'.repeat(20));
    } catch (e) {
      message = (e as { message?: string }).message ?? '';
    }
    expect(message).toContain('UTF-16');
  });

  it('measures the backend’s `name.length` — 32 astral chars are 64 units and are rejected', () => {
    // the plugin would 500 on this input, so the guard must answer BAD_REQUEST first
    expect(() => assertAccessKeyName('😀'.repeat(ACCESS_KEY_NAME_MAX))).toThrowError(
      expect.objectContaining({ code: 'BAD_REQUEST' }),
    );
    // ...and 16 astral chars (32 units) are exactly at the cap
    expect(assertAccessKeyName('😀'.repeat(16))).toBe('😀'.repeat(16));
  });

  it('trims before measuring — padding over the cap is not a rejection', () => {
    const padded = `${'K'.repeat(30)}     `; // 35 raw chars, 30 after trim
    expect(assertAccessKeyName(padded)).toBe('K'.repeat(30));
  });

  it('whitespace-only is empty after trim — the handlers own the blank path', () => {
    expect(assertAccessKeyName('   ')).toBe('');
  });
});
