// Channels settings surface (SPEC: Channel settings UI, #271 slice 4):
// (a) inspectChannelConfigs is the SINGLE source of truth — the runtime parser
// (tolerant skip) must equal the inspection's ok+enabled projection on every
// input, so the admin path refuses exactly what the runtime would drop;
// (b) channels.update strict-refuses invalid/exotic configs and writes the
// CANONICALIZED array; (c) channels.list surfaces stored entries with status +
// reason + health stamp; (d) a settings change re-arms the boot retry loop
// under the PARTIAL-START law. The db singleton is mocked — no-real-DB law.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../server/domains/kernel/env', () => ({
  env: { TANDEM_VAULT_KEY: Buffer.alloc(32, 7).toString('base64'), TANDEM_NO_DISPATCHER: '1' },
}));

vi.mock('../../server/domains/settings/settings.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/domains/settings/settings.service')>();
  return { ...actual, getSetting: vi.fn(), getSettingUpdatedAt: vi.fn(), setSetting: vi.fn(), deleteSetting: vi.fn() };
});

// existence checks ride drizzle select chains — the mock HONORS the caller's
// where predicate (DB-MOCK PREDICATE LAW): the drizzle SQL condition exposes
// its chunks ([Column, StringChunk, [Param,...]] for inArray), so the fake
// where() filters the pool by the ACTUAL bound column + values — a test that
// stops matching the router's real predicate goes red
vi.mock('../../server/db/index', async () => {
  const { vaultSecrets, user } = await import('../../server/db/schema');
  const rowsFor = (t: unknown): Array<Record<string, unknown>> => {
    if (t === vaultSecrets) return [{ id: 'sec-1' }];
    if (t === user)
      return [{ id: '00000000-0000-4000-8000-000000000001' }, { id: '00000000-0000-4000-8000-000000000002' }];
    return [];
  };
  function honorPredicate(table: unknown, cond: unknown): Array<Record<string, unknown>> {
    const pool = rowsFor(table);
    if (cond == null) return pool;
    let column: string | null = null;
    const values: string[] = [];
    for (const chunk of (cond as { queryChunks?: unknown[] }).queryChunks ?? []) {
      const c = chunk as { name?: unknown; columnType?: unknown };
      if (typeof c.columnType === 'string' && typeof c.name === 'string') column = c.name;
      if (Array.isArray(chunk)) {
        for (const p of chunk as Array<{ value?: unknown }>) {
          if (p && typeof p === 'object' && 'value' in p) values.push(String(p.value));
        }
      }
    }
    if (column !== 'id') return []; // a predicate on any other column matches nothing we seed
    return pool.filter((r) => values.includes(String(r.id)));
  }
  return {
    db: {
      query: {
        // resolveToken reads the vault secret relationally; the boot sweep
        // reads the event/outbox relations (serialization test drives the
        // REAL inner start, so these surfaces must answer, not throw)
        vaultSecrets: { findFirst: async () => ({ ciphertext: 'unit-ct' }) },
        channelEvents: { findMany: async () => [] },
        channelOutbox: { findMany: async () => [] },
      },
      select: () => ({
        from: (table: unknown) => ({
          where: (cond: unknown) => Promise.resolve(honorPredicate(table, cond)),
        }),
      }),
    },
  };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...actual, publishChange: vi.fn() };
});

// the serialization test drives the REAL inner start (no-dispatcher opt-out
// disabled in that test alone): the queue domain and token decryption must be
// mockable, or the inner start would touch real redis/vault crypto
vi.mock('../../server/domains/kernel/queue', () => ({
  // the handle must carry close(): stopChannels tears workers down via
  // workerHandle?.close() — a close-less handle explodes any later stop in
  // this file's SHUFFLED order (vitest sequence.shuffle)
  redisQueue: vi.fn(async () => ({ queue: vi.fn(async () => ({ close: async () => {} })) })),
}));
vi.mock('../../server/domains/vault/secret/secret-crypto.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/domains/vault/secret/secret-crypto.service')>();
  return { ...actual, decryptSecret: vi.fn(() => 'unit-token') };
});

// onChannelsSettingsChanged is wrapped in a passthrough vi.fn: the re-arm tests
// below still exercise the REAL hook, and the update-verb tests can pin that
// the write path actually triggers the runtime re-arm (r2 review: deleting the
// `void onChannelsSettingsChanged()` line must not ship green)
vi.mock('../../server/domains/channels/channels.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/domains/channels/channels.service')>();
  return { ...actual, onChannelsSettingsChanged: vi.fn(actual.onChannelsSettingsChanged) };
});

import { createProcedureClient } from '@orpc/server';

import { CHANGE_ACTION, CHANGE_RESOURCE, ROLE } from '#shared/enums';

import type { ChannelAdapter } from '../../server/domains/channels/adapter';
import { channelsRouter } from '../../server/domains/channels/channels.router';
import {
  CHANNELS_KEY,
  ensureChannelsRunning,
  inspectChannelConfigs,
  onChannelsSettingsChanged,
  parseChannelConfigs,
  stopChannels,
} from '../../server/domains/channels/channels.service';
import { publishChange } from '../../server/domains/kernel/kernel';
import { getSetting, getSettingUpdatedAt, setSetting } from '../../server/domains/settings/settings.service';

const rearmSpy = vi.mocked(onChannelsSettingsChanged);

const VALID = {
  kind: 'matrix',
  enabled: true,
  homeserverUrl: 'https://matrix.example.org',
  tokenSecretId: 'sec-1',
  bindings: [{ platformUserId: '@u:example.org', userId: '00000000-0000-4000-8000-000000000001' }],
  defaultAssigneeId: null,
};

// ---- helpers ----
const mockedGet = vi.mocked(getSetting);
const mockedGetUpd = vi.mocked(getSettingUpdatedAt);
const mockedSet = vi.mocked(setSetting);
const mockedPublish = vi.mocked(publishChange);

function callFor<P extends object>(procedure: P, role: typeof ROLE.ADMIN | typeof ROLE.EMPLOYEE) {
  const session = {
    sessionId: 'unit-session-row',
    user: { id: 'u1', name: 'Unit', email: 'unit@tandem.local', role },
  };
  return createProcedureClient(
    procedure as never,
    { context: { reqHeaders: undefined, getSession: async () => session } } as never,
  ) as (input?: unknown) => Promise<unknown>;
}

const ADMIN_UPDATE = callFor(channelsRouter.update, ROLE.ADMIN);
const ADMIN_LIST = callFor(channelsRouter.list, ROLE.ADMIN);

beforeEach(() => {
  vi.clearAllMocks();
  mockedGet.mockResolvedValue(null);
  mockedGetUpd.mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------- (a) parser/inspection parity — the drift guard ----------
describe('inspectChannelConfigs: single source of truth (SPEC slice 4)', () => {
  const RAW_CASES: Array<string | null> = [
    null,
    '',
    '   ',
    '{not json',
    '{"kind":"matrix"}',
    '[]',
    JSON.stringify([VALID]),
    JSON.stringify([{ ...VALID, enabled: false }]),
    JSON.stringify([VALID, { ...VALID, kind: 'discord' }]),
    JSON.stringify([
      { ...VALID, homeserverUrl: 'https://M.EXAMPLE.org/' },
      { ...VALID, tokenSecretId: '' },
    ]),
    // canonicalize BEFORE dedupe: same homeserver, different spelling
    JSON.stringify([{ ...VALID }, { ...VALID, homeserverUrl: 'https://matrix.example.org:443' }]),
    // a DISABLED duplicate must not shadow the enabled one (runtime parity)
    JSON.stringify([{ ...VALID, enabled: false }, { ...VALID }]),
    JSON.stringify([
      VALID,
      { ...VALID, bindings: [{ platformUserId: '@x:org', userId: '00000000-0000-4000-8000-000000000001' }] },
    ]),
    JSON.stringify([{ ...VALID, defaultAssigneeId: '00000000-0000-4000-8000-000000000009' }]),
  ];

  it('parseChannelConfigs(raw) === inspection(ok && enabled).cfg for every case', () => {
    for (const raw of RAW_CASES) {
      const parsed = parseChannelConfigs(raw);
      const projection = inspectChannelConfigs(raw)
        .entries.filter((e) => e.status === 'ok' && e.cfg?.enabled)
        .map((e) => e.cfg);
      expect(parsed, `drift on raw: ${String(raw)}`).toEqual(projection);
    }
  });

  it('inspection carries drop reasons the admin path can surface', () => {
    const insp = inspectChannelConfigs(JSON.stringify([VALID, { ...VALID, kind: 'discord' }]));
    expect(insp.entries[1]).toMatchObject({ status: 'dropped' });
    expect(insp.entries[1]?.reason).toContain('no registered adapter');
  });

  it('exact-content duplicates collapse to one channel (identical twins)', () => {
    // r5 review: byte-identical same-key twins both inspected "ok" and their
    // identical fingerprints collided row identity in the card (delete-one
    // removed both) — inspection now collapses them: first ok, rest dropped
    const insp = inspectChannelConfigs(JSON.stringify([VALID, { ...VALID }]));
    expect(insp.entries.map((e) => e.status)).toEqual(['ok', 'dropped']);
    expect(insp.entries[1]?.reason).toContain('exact duplicate');
    // identical DISABLED twins: one ok row survives, parse still sees none
    const disabled = JSON.stringify([
      { ...VALID, enabled: false },
      { ...VALID, enabled: false },
    ]);
    expect(inspectChannelConfigs(disabled).entries.map((e) => e.status)).toEqual(['ok', 'dropped']);
    expect(parseChannelConfigs(disabled)).toEqual([]);
    expect(parseChannelConfigs(JSON.stringify([VALID, { ...VALID }]))).toHaveLength(1);
  });

  it('canonicalization is visible in the inspection cfg (UI shows what runs)', () => {
    const insp = inspectChannelConfigs(JSON.stringify([{ ...VALID, homeserverUrl: 'https://MATRIX.example.org//' }]));
    expect(insp.entries[0]?.status).toBe('ok');
    expect(insp.entries[0]?.cfg?.homeserverUrl).toBe('https://matrix.example.org');
  });
});

// ---------- (b) channels.update: strict admin-path validation ----------
describe('channels.update (SPEC: strict refuse, nothing written on refusal)', () => {
  it('admin writes the CANONICALIZED array and re-arms + publishes', async () => {
    await expect(
      ADMIN_UPDATE({ channels: [{ ...VALID, homeserverUrl: 'https://Matrix.Example.org:443/' }] }),
    ).resolves.toMatchObject({ ok: true });
    expect(mockedSet).toHaveBeenCalledWith(
      CHANNELS_KEY,
      JSON.stringify([{ ...VALID, homeserverUrl: 'https://matrix.example.org' }]),
    );
    expect(mockedPublish).toHaveBeenCalledWith(CHANGE_RESOURCE.SETTINGS, CHANGE_ACTION.UPDATE);
    expect(rearmSpy).toHaveBeenCalledTimes(1); // the write path re-arms the runtime (SPEC)
  });

  it('unknown kind -> BAD_REQUEST, nothing written', async () => {
    await expect(ADMIN_UPDATE({ channels: [{ ...VALID, kind: 'discord' }] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it('duplicate adapter keys (post-canonicalization) -> BAD_REQUEST, nothing written', async () => {
    await expect(
      ADMIN_UPDATE({ channels: [VALID, { ...VALID, homeserverUrl: 'https://matrix.example.org/' }] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it('an exact-duplicate array is refused, nothing written (admin hygiene)', async () => {
    await expect(ADMIN_UPDATE({ channels: [VALID, { ...VALID }] })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it('a write whose base updatedAt drifted -> refused, nothing written (lost-update guard)', async () => {
    // the stored row moved since the admin's snapshot — a REPLACE write from
    // the stale snapshot would silently delete rows added since: refuse
    mockedGetUpd.mockResolvedValue(new Date('2026-01-02T00:00:00.000Z'));
    await expect(ADMIN_UPDATE({ channels: [VALID] })).rejects.toThrow(/changed since you loaded/);
    expect(mockedSet).not.toHaveBeenCalled();
    await expect(ADMIN_UPDATE({ channels: [VALID], baseUpdatedAt: '2026-01-01T00:00:00.000Z' })).rejects.toThrow(
      /changed since you loaded/,
    );
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it('a write whose base updatedAt matches commits, and list exposes the base', async () => {
    mockedGetUpd.mockResolvedValue(new Date('2026-01-02T00:00:00.000Z'));
    await expect(ADMIN_UPDATE({ channels: [VALID], baseUpdatedAt: '2026-01-02T00:00:00.000Z' })).resolves.toMatchObject(
      { ok: true },
    );
    expect(mockedSet).toHaveBeenCalledWith(CHANNELS_KEY, JSON.stringify([VALID]));
    await expect(ADMIN_LIST()).resolves.toMatchObject({ updatedAt: '2026-01-02T00:00:00.000Z' });
  });

  it('a wrong-shape health stamp degrades to absent health (render-crash guard)', async () => {
    mockedGet.mockImplementation(async (key: string) =>
      key === 'channels:health' ? '{"channels":"not-an-array"}' : JSON.stringify([VALID]),
    );
    const list = (await ADMIN_LIST()) as { health: unknown };
    expect(list.health).toBeNull(); // valid JSON, wrong shape — never reaches the UI
  });

  it('a same-key pair regardless of enabled flag -> BAD_REQUEST (admin-path hygiene)', async () => {
    // the runtime parser only dedupes ENABLED entries — the ADMIN path refuses
    // an enabled+disabled pair for one bot: ambiguous config the UI cannot
    // safely operate on (SPEC: ADMIN-PATH-HYGIENE)
    await expect(ADMIN_UPDATE({ channels: [VALID, { ...VALID, enabled: false }] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockedSet).not.toHaveBeenCalled();
    expect(rearmSpy).not.toHaveBeenCalled(); // a refused write never re-arms
  });

  it('unknown keys INSIDE a binding are refused, not stripped (nested strict input)', async () => {
    await expect(
      ADMIN_UPDATE({
        channels: [
          {
            ...VALID,
            bindings: [
              { platformUserId: '@u:example.org', userId: '00000000-0000-4000-8000-000000000001', badge: 'x' },
            ],
          },
        ],
      }),
    ).rejects.toThrow();
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it('token secret missing from vault -> BAD_REQUEST, nothing written', async () => {
    await expect(ADMIN_UPDATE({ channels: [{ ...VALID, tokenSecretId: 'sec-404' }] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it('binding user not found -> BAD_REQUEST, nothing written', async () => {
    await expect(
      ADMIN_UPDATE({
        channels: [
          { ...VALID, bindings: [{ platformUserId: '@u:x', userId: '99999999-9999-4999-8999-999999999999' }] },
        ],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it('default assignee not found -> BAD_REQUEST, nothing written', async () => {
    await expect(
      ADMIN_UPDATE({ channels: [{ ...VALID, defaultAssigneeId: '00000000-0000-4000-8000-000000000404' }] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it('non-uuid binding id is refused at input validation', async () => {
    await expect(
      ADMIN_UPDATE({ channels: [{ ...VALID, bindings: [{ platformUserId: '@u:x', userId: 'nope' }] }] }),
    ).rejects.toThrow();
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it('unknown keys are refused (strict admin input — no silent strip)', async () => {
    await expect(ADMIN_UPDATE({ channels: [{ ...VALID, badge: 'x' }] })).rejects.toThrow();
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it('EMPLOYEE tier -> FORBIDDEN (admin-only config)', async () => {
    await expect(callFor(channelsRouter.update, ROLE.EMPLOYEE)({ channels: [VALID] })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(rearmSpy).not.toHaveBeenCalled(); // a gated-out write never re-arms
  });
});

// ---------- (e) stopped invariant: a stopped module stays stopped ----------
describe('stopChannels disarms the settings-change re-arm', () => {
  it('after an explicit stop, onChannelsSettingsChanged is a no-op (no resurrection)', async () => {
    await stopChannels();
    const start = vi.fn().mockResolvedValue([]);
    await onChannelsSettingsChanged(start);
    expect(start).not.toHaveBeenCalled(); // the hook never even starts
    // a DIRECT startChannels() after a stop is a deliberate restart (the
    // stop/start cycle law) — the invariant guards only the settings hook
    // a boot (re)start lifts the invariant again
    const stop = ensureChannelsRunning({ start, intervalMs: 10_000 });
    await new Promise((r) => setTimeout(r, 5));
    await onChannelsSettingsChanged(start);
    expect(start.mock.calls.length).toBeGreaterThanOrEqual(2); // boot attempt + hook start
    stop(); // ensureChannelsRunning already lifted the stopped invariant
  });
});

// ---------- (c) channels.list ----------
describe('channels.list (SPEC: dropped configs visible, admin-only)', () => {
  it('returns stored entries with status/reason, kinds and the health stamp', async () => {
    mockedGet.mockImplementation(async (key: string) => {
      if (key === CHANNELS_KEY) return JSON.stringify([VALID, { ...VALID, kind: 'discord' }]);
      if (key === 'channels:health')
        return JSON.stringify({
          stampedAt: 1,
          channels: [{ key: 'matrix:https://matrix.example.org', connected: true }],
        });
      return null;
    });
    const res = (await ADMIN_LIST(undefined)) as {
      kinds: string[];
      corrupt: string | null;
      entries: Array<{ status: string; reason: string; entry: { kind: string } | null }>;
      health: { channels: Array<{ connected: boolean }> } | null;
    };
    expect(res.kinds).toContain('matrix');
    expect(res.corrupt).toBeNull();
    expect(res.entries).toHaveLength(2);
    expect(res.entries[0]).toMatchObject({
      status: 'ok',
      entry: { kind: 'matrix', homeserverUrl: 'https://matrix.example.org' },
    });
    expect(res.entries[1]).toMatchObject({ status: 'dropped' });
    expect(res.entries[1]?.reason).toContain('no registered adapter');
    expect(res.health?.channels?.[0]?.connected).toBe(true);
  });

  it('a corrupt stored value surfaces corrupt + no entries (never throws)', async () => {
    mockedGet.mockResolvedValue('{oops');
    const res = (await ADMIN_LIST(undefined)) as { corrupt: string | null; entries: unknown[] };
    expect(res.corrupt).toBeTruthy();
    expect(res.entries).toEqual([]);
  });

  it('EMPLOYEE tier -> FORBIDDEN', async () => {
    await expect(callFor(channelsRouter.list, ROLE.EMPLOYEE)(undefined)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

// ---------- (d) settings-change re-arm (PARTIAL-START law) ----------
describe('onChannelsSettingsChanged re-arm', () => {
  function startMock() {
    return vi
      .fn()
      .mockResolvedValueOnce([]) // boot start: clean -> done, timer cleared
      .mockResolvedValueOnce(['matrix:down']) // hook start: partial -> loop re-armed
      .mockResolvedValueOnce([]) // re-arm attempt: clean -> done
      .mockResolvedValue([]); // any further tick
  }

  it('a failed re-arm start re-arms the boot retry loop; a clean one settles it', async () => {
    vi.useFakeTimers();
    const start = startMock();
    const stop = ensureChannelsRunning({ start, intervalMs: 10 });
    await vi.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(50);
    expect(start).toHaveBeenCalledTimes(1); // done: no timer ticks

    await onChannelsSettingsChanged(start); // hook fires its OWN start (partial)
    await vi.advanceTimersByTimeAsync(0);
    // hook start + the synchronous rearm attempt (the failed hook start re-arms
    // INSIDE its own .then, before the awaited hook promise settles)
    expect(start).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(20);
    expect(start).toHaveBeenCalledTimes(3); // the rearm attempt settled it
    await vi.advanceTimersByTimeAsync(50);
    expect(start).toHaveBeenCalledTimes(3); // done again: quiet
    stop();
  });

  it('a thrown re-arm start still re-arms (never strands a partial config)', async () => {
    vi.useFakeTimers();
    const start = vi
      .fn()
      .mockResolvedValueOnce([]) // boot start: clean
      .mockRejectedValueOnce(new Error('redis down')) // hook start throws
      .mockResolvedValue([]); // re-armed attempt settles
    const stop = ensureChannelsRunning({ start, intervalMs: 10 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(onChannelsSettingsChanged(start)).resolves.toBeUndefined(); // hook never throws
    await vi.advanceTimersByTimeAsync(20);
    expect(start).toHaveBeenCalledTimes(3);
    stop();
  });

  it('re-arm keeps retrying through CONSECUTIVE failures (stale-timer regression pin)', async () => {
    vi.useFakeTimers();
    const start = vi
      .fn()
      .mockResolvedValueOnce([]) // boot start: clean -> done, timer cleared (handle MUST null)
      .mockResolvedValueOnce(['x']) // hook start: partial
      .mockResolvedValueOnce(['x']) // re-arm attempt: STILL failing — the case
      // where a stale truthy timer handle would strand the loop with 0 retries
      .mockResolvedValueOnce(['x']) // tick: still failing
      .mockResolvedValue([]); // next tick recovers -> settles
    const stop = ensureChannelsRunning({ start, intervalMs: 10 });
    await vi.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledTimes(1);
    await onChannelsSettingsChanged(start);
    await vi.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledTimes(3); // hook start + re-arm attempt (both failing)
    await vi.advanceTimersByTimeAsync(10);
    expect(start).toHaveBeenCalledTimes(4); // retry tick fired — the r1-P1 pin
    await vi.advanceTimersByTimeAsync(30);
    expect(start).toHaveBeenCalledTimes(5); // recovered
    await vi.advanceTimersByTimeAsync(50);
    expect(start).toHaveBeenCalledTimes(5); // settled: quiet
    stop();
  });
});

describe('startChannels serialization + empty-array write', () => {
  it('overlapping startChannels calls resolve through the chain (no deadlock)', async () => {
    const { startChannels } = await import('../../server/domains/channels/channels.service');
    // TANDEM_NO_DISPATCHER=1 makes each inner a fast no-op, but both calls must
    // ride the serialization chain — a broken chain (e.g. a poisoned rejection
    // short-circuit) would strand the second caller
    const [a, b] = await Promise.all([startChannels(), startChannels()]);
    expect(a).toEqual([]);
    expect(b).toEqual([]);
  });

  it('concurrent starts never overlap the adapter start loop (observable serialization)', async () => {
    // r5 review: the chain test above passes even with the chain deleted (the
    // no-dispatcher inner is a no-op) — this pin observes the REAL inner:
    // three concurrent starts, each with its OWN adapter key, must serialize
    // (max 1 adapter start in flight); deleting the chain lets all three
    // interleave and this goes red
    const adapterMod = await import('../../server/domains/channels/adapter');
    const { startChannels, stopChannels } = await import('../../server/domains/channels/channels.service');
    const { env } = await import('../../server/domains/kernel/env');
    let active = 0;
    let maxActive = 0;
    const fakeAdapter = (): ChannelAdapter => ({
      kind: 'testkind',
      capabilities: { edit: false, threads: false, maxLen: 100, markdown: false },
      start: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 25));
        active -= 1;
      },
      stop: async () => {},
      send: async () => {},
    });
    adapterMod.registerChannelAdapter('testkind', () => fakeAdapter());
    // each inner start reads its OWN config (distinct keys), so the
    // already-active skip cannot mask overlap
    let call = 0;
    mockedGet.mockImplementation(async () => {
      call += 1;
      return JSON.stringify([
        {
          kind: 'testkind',
          enabled: true,
          homeserverUrl: `https://t${call}.example.org`,
          tokenSecretId: 'sec-1',
          bindings: [],
          defaultAssigneeId: null,
        },
      ]);
    });
    const priorDispatcher = env.TANDEM_NO_DISPATCHER;
    env.TANDEM_NO_DISPATCHER = ''; // drive the REAL inner start
    try {
      expect(await Promise.all([startChannels(), startChannels(), startChannels()])).toEqual([[], [], []]);
      expect(maxActive).toBe(1); // the serialization contract, observed
    } finally {
      env.TANDEM_NO_DISPATCHER = priorDispatcher;
      mockedGet.mockResolvedValue(null);
      await stopChannels(); // disarms the armed health tick + drops adapters
    }
  });

  it('update with an empty array writes "[]" (replace-to-empty is legal)', async () => {
    await expect(ADMIN_UPDATE({ channels: [] })).resolves.toMatchObject({ ok: true });
    expect(mockedSet).toHaveBeenCalledWith(CHANNELS_KEY, '[]');
  });
});
