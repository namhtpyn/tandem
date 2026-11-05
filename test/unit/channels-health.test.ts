// Channel watchdog health stamps (SPEC: Channels — Watchdog health, slice 3,
// #271). The db singleton is captured/mocked — no-real-DB unit law; the stamp
// contract under test: shape, connected truth (started vs failed-to-start vs
// dead), optional-health null semantics, throwing-health isolation, empty
// config array, and tick isolation (a failing settings write never throws).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../server/db/index', () => ({
  db: {
    query: {
      channelEvents: { findMany: async () => [], findFirst: async () => null },
      channelOutbox: { findMany: async () => [], findFirst: async () => null },
      channelThreads: { findFirst: async () => null },
      vaultSecrets: { findFirst: async () => ({ ciphertext: 'enc' }) },
    },
  },
}));

// deterministic transport: stubbed PER TEST (vitest unstubGlobals:true clears
// module-level stubs before every test — a top-level stub is inert and the
// start attempt would hit real DNS). A start attempt fails fast and must
// stamp its entry connected:false.
const fetchStub = vi.fn(async () => {
  throw new Error('no network in unit tests');
});

// hoisted so the vi.mock factories (which run before top-level consts) can
// reach it — per-test TANDEM_NO_DISPATCHER flips
const envState = vi.hoisted(() => ({ TANDEM_NO_DISPATCHER: '1' }));

vi.mock('../../server/domains/kernel/env', () => ({
  env: {
    get TANDEM_VAULT_KEY() {
      return Buffer.alloc(32, 7).toString('base64');
    },
    get TANDEM_NO_DISPATCHER() {
      return envState.TANDEM_NO_DISPATCHER;
    },
  },
}));

vi.mock('../../server/domains/kernel/queue', () => ({
  redisQueue: async () => ({
    enqueue: async () => {},
    queue: async () => ({ close: async () => {} }),
  }),
}));

vi.mock('../../server/domains/vault/secret/secret-crypto.service', () => ({
  decryptSecret: async () => 'tok',
}));

const settingsRows = new Map<string, string>();
let settingsWriteFail = false;

vi.mock('../../server/domains/settings/settings.service', () => ({
  getSetting: async (key: string) => settingsRows.get(key) ?? null,
  setSetting: async (key: string, value: string) => {
    if (settingsWriteFail) throw new Error('settings write down');
    settingsRows.set(key, value);
  },
}));

import type { ChannelAdapter } from '../../server/domains/channels/adapter';
import {
  CHANNELS_HEALTH_KEY,
  attachAdapterForTests,
  startChannels,
  stopChannels,
  writeChannelHealthStamp,
} from '../../server/domains/channels/channels.service';

const VALID = {
  kind: 'matrix',
  enabled: true,
  homeserverUrl: 'https://matrix.example.org',
  tokenSecretId: 'secret-1',
  bindings: [{ platformUserId: '@u:example.org', userId: '00000000-0000-4000-8000-000000000001' }],
  defaultAssigneeId: null,
};

function stubAdapter(overrides: Partial<ChannelAdapter> = {}): ChannelAdapter {
  return {
    kind: 'matrix',
    capabilities: { edit: false, threads: false, maxLen: 4000, markdown: false },
    start: async () => {},
    stop: async () => {},
    isLive: () => true,
    health: () => ({ lastSyncOkAt: 1_700_000_000_000 }),
    send: async () => {},
    ...overrides,
  };
}

function stampedChannels(): Array<Record<string, unknown>> {
  const raw = settingsRows.get(CHANNELS_HEALTH_KEY);
  expect(raw, 'health stamp must be written').toBeTruthy();
  const parsed = JSON.parse(raw!) as { stampedAt: number; channels: Array<Record<string, unknown>> };
  expect(typeof parsed.stampedAt).toBe('number');
  return parsed.channels;
}

describe('channel health stamp', () => {
  beforeEach(async () => {
    settingsRows.clear();
    settingsWriteFail = false;
    vi.stubGlobal('fetch', fetchStub); // per test: unstubGlobals clears top-level stubs
    // detach every test adapter + disarm any tick: activeAdapters is module
    // state and tests shuffle — a leaked live stub would flip connected
    await stopChannels();
    envState.TANDEM_NO_DISPATCHER = '1';
  });

  it('a live adapter stamps connected:true and passes lastSyncOkAt through', async () => {
    settingsRows.set('channels', JSON.stringify([VALID]));
    attachAdapterForTests('matrix:https://matrix.example.org', stubAdapter());
    await writeChannelHealthStamp();
    const ch = stampedChannels();
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({
      key: 'matrix:https://matrix.example.org',
      kind: 'matrix',
      homeserverUrl: 'https://matrix.example.org',
      connected: true,
      healthCap: true,
      healthOk: true,
      lastSyncOkAt: 1_700_000_000_000,
    });
  });

  it('an enabled config whose adapter never started stamps connected:false + healthCap:false (the signal)', async () => {
    settingsRows.set('channels', JSON.stringify([VALID]));
    await writeChannelHealthStamp(); // no adapter attached: failed/pending start
    const ch = stampedChannels();
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ connected: false, healthCap: false, healthOk: false, lastSyncOkAt: null });
  });

  it('a KEPT config stored under a NON-CANONICAL url never grows a phantom dropped entry', async () => {
    settingsRows.set('channels', JSON.stringify([{ ...VALID, homeserverUrl: 'https://Matrix.example.org/' }]));
    attachAdapterForTests('matrix:https://matrix.example.org', stubAdapter()); // canonical key
    await writeChannelHealthStamp();
    const ch = stampedChannels();
    expect(ch, 'one config = ONE entry (canonical key law)').toHaveLength(1);
    expect(ch[0]).toMatchObject({ key: 'matrix:https://matrix.example.org', connected: true });
  });

  it('an adapter reporting isLive:false stamps connected:false but keeps its transport stamp', async () => {
    settingsRows.set('channels', JSON.stringify([VALID]));
    attachAdapterForTests(
      'matrix:https://matrix.example.org',
      stubAdapter({ isLive: () => false }), // fatal stop (dead token)
    );
    await writeChannelHealthStamp();
    const ch = stampedChannels();
    expect(ch[0]).toMatchObject({ connected: false, lastSyncOkAt: 1_700_000_000_000 });
  });

  it('an adapter WITHOUT health() reports lastSyncOkAt:null + healthCap:false (never invented stale)', async () => {
    settingsRows.set('channels', JSON.stringify([VALID]));
    const { health: _omit, ...noHealth } = stubAdapter();
    attachAdapterForTests('matrix:https://matrix.example.org', noHealth as ChannelAdapter);
    await writeChannelHealthStamp();
    const ch = stampedChannels();
    expect(ch[0]).toMatchObject({ connected: true, healthCap: false, healthOk: false, lastSyncOkAt: null });
  });

  it('a throwing health() with a live isLive() must NOT fabricate never-synced (healthOk:false marks the read failed)', async () => {
    settingsRows.set('channels', JSON.stringify([VALID]));
    attachAdapterForTests(
      'matrix:https://matrix.example.org',
      stubAdapter({
        health: () => {
          throw new Error('health exploded');
        },
      }),
    );
    await writeChannelHealthStamp();
    const ch = stampedChannels();
    // connected stays TRUE (transport is fine), but the null is flagged as a
    // FAILED READ — the probe must not raise the never-synced transport alert
    expect(ch[0]).toMatchObject({
      connected: true,
      healthCap: true,
      healthOk: false,
      lastSyncOkAt: null,
    });
  });

  it('a throwing isLive() degrades to connected:false without faking a health fault', async () => {
    settingsRows.set('channels', JSON.stringify([VALID]));
    attachAdapterForTests(
      'matrix:https://matrix.example.org',
      stubAdapter({
        isLive: () => {
          throw new Error('isLive exploded');
        },
      }),
    );
    await writeChannelHealthStamp();
    const ch = stampedChannels();
    expect(ch[0]).toMatchObject({
      connected: false,
      healthCap: true,
      healthOk: true,
      lastSyncOkAt: 1_700_000_000_000,
    });
  });

  it('a throwing health() AND isLive() degrades to its OWN entry, never kills the stamp', async () => {
    settingsRows.set('channels', JSON.stringify([VALID]));
    attachAdapterForTests(
      'matrix:https://matrix.example.org',
      stubAdapter({
        health: () => {
          throw new Error('health exploded');
        },
        isLive: () => {
          throw new Error('isLive exploded');
        },
      }),
    );
    await writeChannelHealthStamp();
    const ch = stampedChannels(); // the stamp still landed
    expect(ch[0]).toMatchObject({ connected: false, healthCap: true, healthOk: false, lastSyncOkAt: null });
  });

  it('an ENABLED config the parser dropped (unregistered kind) stamps connected:false — never invisible', async () => {
    settingsRows.set(
      'channels',
      JSON.stringify([VALID, { ...VALID, kind: 'discord' }]), // schema-valid, no adapter registered
    );
    await writeChannelHealthStamp();
    const ch = stampedChannels();
    expect(ch).toHaveLength(2);
    expect(ch[1]).toMatchObject({
      key: 'discord:https://matrix.example.org',
      kind: 'discord',
      connected: false,
      healthCap: false,
      healthOk: false,
      lastSyncOkAt: null,
    });
  });

  it('zero enabled configs stamp an EMPTY channels array (disabled must not read stale)', async () => {
    settingsRows.set('channels', JSON.stringify([{ ...VALID, enabled: false }]));
    await writeChannelHealthStamp();
    expect(stampedChannels()).toEqual([]);
  });

  it('a failing settings write is swallowed (tick isolation — observability never crashes)', async () => {
    settingsRows.set('channels', JSON.stringify([VALID]));
    settingsWriteFail = true;
    await expect(writeChannelHealthStamp()).resolves.toBeUndefined();
  });
});

describe('channel health tick lifecycle', () => {
  beforeEach(async () => {
    settingsRows.clear();
    settingsWriteFail = false;
    vi.stubGlobal('fetch', fetchStub);
    await stopChannels();
    envState.TANDEM_NO_DISPATCHER = '';
  });

  it('startChannels arms the tick (stamp refreshes with time), stopChannels disarms it; a failed start stamps connected:false', async () => {
    vi.useFakeTimers();
    try {
      settingsRows.set('channels', JSON.stringify([{ ...VALID, homeserverUrl: 'https://matrix2.example.org' }]));
      // transport stub always throws → the adapter fails to start → the
      // PARTIAL-START law keeps the retry loop, and the stamp must report
      // connected:false for that entry immediately (own homeserver: earlier
      // tests' attached stubs must not leak a live adapter into this key)
      await startChannels();
      expect(fetchStub).toHaveBeenCalled(); // the start failed on OUR stub, not on real DNS
      let ch = stampedChannels();
      expect(ch).toHaveLength(1);
      expect(ch[0]).toMatchObject({
        key: 'matrix:https://matrix2.example.org',
        connected: false,
        healthCap: false, // never registered: no adapter object at all
      });
      const bootStamp = (JSON.parse(settingsRows.get(CHANNELS_HEALTH_KEY)!) as { stampedAt: number }).stampedAt;

      await vi.advanceTimersByTimeAsync(61_000); // one tick fired
      const stampedAtAfterTick = (JSON.parse(settingsRows.get(CHANNELS_HEALTH_KEY)!) as { stampedAt: number })
        .stampedAt;
      expect(stampedAtAfterTick, 'tick must REFRESH the stamp (armed ≠ inert)').toBeGreaterThan(bootStamp);

      await stopChannels();
      settingsRows.set(CHANNELS_HEALTH_KEY, JSON.stringify({ stampedAt: 0, channels: [] }));
      await vi.advanceTimersByTimeAsync(180_000); // 3 ticks would fire if armed
      ch = stampedChannels(); // still the ZEROED value: the tick is disarmed
      expect(ch).toEqual([]);
      expect((JSON.parse(settingsRows.get(CHANNELS_HEALTH_KEY)!) as { stampedAt: number }).stampedAt).toBe(0);
      expect(stampedAtAfterTick).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
      envState.TANDEM_NO_DISPATCHER = '1';
    }
  });
});
