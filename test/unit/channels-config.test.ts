// Channel config parse + identity binding (SPEC: Channels — Channel config,
// Identity binding default deny, #271 slice 1). The db singleton is mocked —
// no-real-DB unit law; parse/resolve are pure over the settings value.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../server/domains/kernel/env', () => ({
  env: { TANDEM_VAULT_KEY: Buffer.alloc(32, 7).toString('base64'), TANDEM_NO_DISPATCHER: '1' },
}));

vi.mock('../../server/db/index', () => ({ db: { query: {} } }));

import { parseChannelConfigs, resolveBinding } from '../../server/domains/channels/channels.service';

const VALID = {
  kind: 'matrix',
  enabled: true,
  homeserverUrl: 'https://matrix.example.org',
  tokenSecretId: 'secret-1',
  bindings: [{ platformUserId: '@u:example.org', userId: '00000000-0000-4000-8000-000000000001' }],
  defaultAssigneeId: null,
};

describe('parseChannelConfigs', () => {
  it('null / empty / corrupt JSON / non-array all read as no channels (fail closed)', () => {
    expect(parseChannelConfigs(null)).toEqual([]);
    expect(parseChannelConfigs('')).toEqual([]);
    expect(parseChannelConfigs('   ')).toEqual([]);
    expect(parseChannelConfigs('{not json')).toEqual([]);
    expect(parseChannelConfigs('{"kind":"matrix"}')).toEqual([]);
  });

  it('invalid entries are skipped, valid ones survive', () => {
    const raw = JSON.stringify([
      VALID,
      { ...VALID, kind: 'discord' }, // schema pins slice-1 kinds
      { ...VALID, homeserverUrl: 'not-a-url' },
      { ...VALID, tokenSecretId: '' },
      { ...VALID, enabled: false },
    ]);
    const out = parseChannelConfigs(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.homeserverUrl).toBe('https://matrix.example.org');
    expect(out[0]!.bindings).toHaveLength(1);
  });

  it('duplicate adapter keys are refused (first wins, one bot per homeserver)', () => {
    const out = parseChannelConfigs(JSON.stringify([VALID, { ...VALID }]));
    expect(out).toHaveLength(1);
  });

  it('defaults: bindings empty, defaultAssigneeId null', () => {
    const out = parseChannelConfigs(
      JSON.stringify([{ kind: 'matrix', enabled: true, homeserverUrl: 'https://m.example.org', tokenSecretId: 's' }]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.bindings).toEqual([]);
    expect(out[0]!.defaultAssigneeId).toBeNull();
  });
});

describe('resolveBinding (default deny)', () => {
  function cfgFor() {
    const out = parseChannelConfigs(JSON.stringify([VALID]));
    expect(out, `parsed: ${JSON.stringify(out)}`).toHaveLength(1);
    return out[0]!;
  }

  it('a bound platform id acts as its Tandem user', () => {
    expect(resolveBinding(cfgFor(), '@u:example.org')).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('an unbound platform id is denied (null)', () => {
    expect(resolveBinding(cfgFor(), '@stranger:example.org')).toBeNull();
  });
});
