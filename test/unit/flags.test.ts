// flags: the tolerant, fail-closed reader (SPEC: Settings > Feature flags) —
// every invalid shape reads as NO flags; valid maps pass through untouched
import { describe, expect, it } from 'vitest';

import { FLAG_NAME_RE, MAX_FLAGS, isValidFlagsPayload, parseFlags } from '../../shared/flags.ts';

describe('FLAG_NAME_RE', () => {
  it('accepts lowercase names starting with a letter', () => {
    expect(FLAG_NAME_RE.test('tasks.turn-durations')).toBe(true);
    expect(FLAG_NAME_RE.test('a')).toBe(true);
    expect(FLAG_NAME_RE.test('x-1_y.2z')).toBe(true);
    expect(FLAG_NAME_RE.test('a'.repeat(40))).toBe(true);
  });

  it('rejects uppercase starts, leading digits/symbols, and 41-char names', () => {
    expect(FLAG_NAME_RE.test('Tasks.turnDurations')).toBe(false);
    expect(FLAG_NAME_RE.test('1abc')).toBe(false);
    expect(FLAG_NAME_RE.test('_abc')).toBe(false);
    expect(FLAG_NAME_RE.test('bad name')).toBe(false);
    expect(FLAG_NAME_RE.test('a'.repeat(41))).toBe(false);
  });
});

describe('parseFlags', () => {
  it('null and missing key read as no flags', () => {
    expect(parseFlags(null)).toEqual({});
  });

  it('unparsable JSON reads as no flags', () => {
    expect(parseFlags('{not json')).toEqual({});
    expect(parseFlags('')).toEqual({});
  });

  it('non-object payloads read as no flags (strings, numbers, arrays, booleans)', () => {
    expect(parseFlags('"on"')).toEqual({});
    expect(parseFlags('42')).toEqual({});
    expect(parseFlags('[true]')).toEqual({});
    expect(parseFlags('true')).toEqual({});
  });

  it('a valid map passes through', () => {
    expect(parseFlags('{"tasks.turn-durations":true,"x":false}')).toEqual({
      'tasks.turn-durations': true,
      x: false,
    });
  });

  it('any invalid entry fails the WHOLE map closed (no partial maps)', () => {
    expect(parseFlags('{"ok.flag":true,"bad Name":true}')).toEqual({});
    expect(parseFlags('{"ok.flag":true,"str":"yes"}')).toEqual({});
    expect(parseFlags('{"ok.flag":1}')).toEqual({});
    expect(parseFlags('{"ok.flag":null}')).toEqual({});
  });

  it('a map over the cap reads as no flags (fail closed, not truncated)', () => {
    const tooMany = Object.fromEntries(Array.from({ length: MAX_FLAGS + 1 }, (_, i) => [`flag${i}x`, true]));
    expect(parseFlags(JSON.stringify(tooMany))).toEqual({});
  });

  it('a map at the cap passes', () => {
    const atCap = Object.fromEntries(Array.from({ length: MAX_FLAGS }, (_, i) => [`flag${i}x`, i % 2 === 0]));
    expect(parseFlags(JSON.stringify(atCap))).toEqual(atCap);
  });
});

describe('isValidFlagsPayload', () => {
  it('a missing key (null) is not corruption', () => {
    expect(isValidFlagsPayload(null)).toBe(true);
  });

  it('valid payloads pass — including the empty map', () => {
    expect(isValidFlagsPayload('{}')).toBe(true);
    expect(isValidFlagsPayload('{"tasks.turn-durations":true}')).toBe(true);
    const atCap = Object.fromEntries(Array.from({ length: MAX_FLAGS }, (_, i) => [`flag${i}x`, true]));
    expect(isValidFlagsPayload(JSON.stringify(atCap))).toBe(true);
  });

  it.each(['', '{bad', '"on"', '42', '[true]', 'true', 'null', '{"Bad Name":true}', '{"ok":1}', '{"ok":null}'])(
    'invalid payload %s fails (parseFlags reads the same payload as {})',
    (raw) => {
      expect(isValidFlagsPayload(raw)).toBe(false);
      expect(parseFlags(raw)).toEqual({});
    },
  );

  it('a map over the cap is invalid, not truncated', () => {
    const tooMany = Object.fromEntries(Array.from({ length: MAX_FLAGS + 1 }, (_, i) => [`flag${i}x`, true]));
    expect(isValidFlagsPayload(JSON.stringify(tooMany))).toBe(false);
  });
});
