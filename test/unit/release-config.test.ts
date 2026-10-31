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
