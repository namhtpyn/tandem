// Release pipeline config — the Release workflow is the ONLY place a broken
// .releaserc.json surfaces (CI never runs semantic-release), and a bad
// releaseRules entry silently blocks EVERY release (the 2026-10-31 incident:
// type-as-key shorthand `{revert: "patch"}` threw "rules must be an object
// with a release property" and no tag landed until it was repaired).
// These asserts run in CI on every PR, so config rot is caught at the gate.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const raw = readFileSync(new URL('../../.releaserc.json', import.meta.url), 'utf8');
const config = JSON.parse(raw) as {
  branches: string[];
  plugins: Array<[string, Record<string, unknown>]>;
};

const VALID_RELEASES = new Set(['major', 'minor', 'patch']);

describe('.releaserc.json', () => {
  it('releases only from main', () => {
    expect(config.branches).toEqual(['main']);
  });

  it('commit-analyzer releaseRules use the long {type, release} form', () => {
    const analyzer = config.plugins.find(([name]) => name === '@semantic-release/commit-analyzer');
    expect(analyzer).toBeDefined();
    const rules = (analyzer?.[1].releaseRules ?? []) as Array<Record<string, unknown>>;
    for (const rule of rules) {
      expect(rule, `releaseRule ${JSON.stringify(rule)} needs a string "type"`).toHaveProperty('type');
      expect(typeof rule.type).toBe('string');
      expect(VALID_RELEASES.has(rule.release as string), `releaseRule ${rule.type} has a valid release`).toBe(true);
    }
  });

  it('still treats revert commits as patch releases', () => {
    const analyzer = config.plugins.find(([name]) => name === '@semantic-release/commit-analyzer');
    const rules = (analyzer?.[1].releaseRules ?? []) as Array<Record<string, unknown>>;
    expect(rules.some((r) => r.type === 'revert' && r.release === 'patch')).toBe(true);
  });
});

// Breaking-header release contract (SPEC.md "Deployment — release commit
// contract", the #461 pass): conventional-commits-parser's parseBreakingHeader
// reads the subject as capture group 3 UNGUARDED (`matches[3]`) and feeds it
// straight into trimNewLines — a breakingHeaderPattern with fewer than 3
// groups pushes note.text = undefined and the Release workflow hard-fails.
// And a scope class narrower than headerPattern's silently demotes a declared
// breaking change (`fix(a+b)!:` shipped patch instead of major).
const PLUGIN_OPTS = config.plugins
  .map(([name, pluginConfig]) => ({ name, opts: (pluginConfig.parserOpts ?? {}) as Record<string, string | string[]> }))
  .filter(({ opts }) => typeof opts.breakingHeaderPattern === 'string');

describe('breaking-header release contract', () => {
  it('every parserOpts block with a breakingHeaderPattern also pins headerPattern', () => {
    expect(PLUGIN_OPTS.length).toBeGreaterThanOrEqual(1);
    for (const { name, opts } of PLUGIN_OPTS) {
      expect(typeof opts.headerPattern, `${name} needs headerPattern beside breakingHeaderPattern`).toBe('string');
    }
  });

  it('breakingHeaderPattern has exactly 3 capture groups (parser reads matches[3] unguarded)', () => {
    for (const { name, opts } of PLUGIN_OPTS) {
      // `(?:(?:pat)|)` — an always-matching empty alternative makes exec('')
      // return a slot for EVERY capture group (all undefined).
      const probe = new RegExp(`(?:(?:${opts.breakingHeaderPattern as string})|)`);
      const matches = probe.exec('');
      expect(matches, `${name} pattern must compile`).not.toBeNull();
      expect(
        matches?.length,
        `${name} breakingHeaderPattern must carry type+scope+subject (3 groups + full match)`,
      ).toBe(4);
    }
  });

  it('breaking scope class == headerPattern scope class (every accepted scope is breaking-capable)', () => {
    for (const { name, opts } of PLUGIN_OPTS) {
      const header = opts.headerPattern as string;
      const breaking = opts.breakingHeaderPattern as string;
      // the scope character classes must be IDENTICAL strings: extract the
      // bracketed class right after the escaped `\(` group opener
      const headerScope = header.match(/\((\[[^\]]*\])/);
      const breakingScope = breaking.match(/\((\[[^\]]*\])/);
      expect(headerScope, `${name} headerPattern scope class shape`).not.toBeNull();
      expect(breakingScope, `${name} breakingHeaderPattern scope class shape`).not.toBeNull();
      expect(breakingScope?.[1], `${name} breaking scope class must equal the header scope class`).toBe(
        headerScope?.[1],
      );
    }
  });

  it('breaking-header case table (regex-level)', () => {
    for (const { name, opts } of PLUGIN_OPTS) {
      const headerRe = new RegExp(opts.headerPattern as string);
      const breakingRe = new RegExp(opts.breakingHeaderPattern as string);
      const cases: Array<[string, boolean, boolean]> = [
        // [subject, headerPattern matches, breakingHeaderPattern matches]
        ['fix(a+b)!: boom', true, true], // the #461-pass hazard shape: MUST be breaking (major)
        ['feat(scope+more)!: y', true, true],
        ['feat(ui)!: new engine', true, true],
        ['chore!: drop legacy API', true, true],
        ['!: x', true, true],
        ['fix(a+b): plain-with-plus', true, false], // non-breaking: header only
        ['feat: clean', true, false],
        ['feat(a+b!extra)!: x', false, false], // `(`/`!` inside scope: rejected by BOTH (no-parse → no-release parity)
        ['chore-2!: x', false, false], // `-` outside scope parens: rejected by BOTH
      ];
      for (const [subject, wantHeader, wantBreaking] of cases) {
        expect(headerRe.test(subject), `${name} headerPattern ${JSON.stringify(subject)}`).toBe(wantHeader);
        expect(breakingRe.test(subject), `${name} breakingHeaderPattern ${JSON.stringify(subject)}`).toBe(wantBreaking);
      }
    }
  });

  it('a matching breaking header always yields a DEFINED subject for the note text', () => {
    for (const { opts } of PLUGIN_OPTS) {
      const breakingRe = new RegExp(opts.breakingHeaderPattern as string);
      for (const subject of ['fix(a+b)!: boom', 'feat!: x', 'chore!: ', '!: y', 'feat(ui)!: z']) {
        const m = breakingRe.exec(subject);
        expect(m, `${JSON.stringify(subject)} must match`).not.toBeNull();
        expect(m?.[3], `${JSON.stringify(subject)} note text (group 3) must be a string`).toEqual(expect.any(String));
      }
    }
  });
});
