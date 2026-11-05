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
  return { ...actual, getSetting: vi.fn(), setSetting: vi.fn(), deleteSetting: vi.fn() };
});

// existence checks ride drizzle select chains — fake the builder shape per
// DB-MOCK law (chained calls need a thenable OBJECT carrying .from + .where);
// the secret pool is {sec-1}, the user pool is {u-1, u-2}
vi.mock('../../server/db/index', async () => {
  const { vaultSecrets, user } = await import('../../server/db/schema');
  const rowsFor = (t: unknown): Array<Record<string, unknown>> => {
    if (t === vaultSecrets) return [{ id: 'sec-1' }];
    if (t === user)
      return [{ id: '00000000-0000-4000-8000-000000000001' }, { id: '00000000-0000-4000-8000-000000000002' }];
    return [];
  };
  return {
    db: {
      query: {},
      select: () => ({
        from: (table: unknown) => ({
          where: () => Promise.resolve(rowsFor(table)),
        }),
      }),
    },
  };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...actual, publishChange: vi.fn() };
});

import { createProcedureClient } from '@orpc/server';

import { CHANGE_ACTION, CHANGE_RESOURCE, ROLE } from '#shared/enums';

import { channelsRouter } from '../../server/domains/channels/channels.router';
import {
  CHANNELS_KEY,
  ensureChannelsRunning,
  inspectChannelConfigs,
  onChannelsSettingsChanged,
  parseChannelConfigs,
} from '../../server/domains/channels/channels.service';
import { publishChange } from '../../server/domains/kernel/kernel';
import { getSetting, setSetting } from '../../server/domains/settings/settings.service';

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

  it('update with an empty array writes "[]" (replace-to-empty is legal)', async () => {
    await expect(ADMIN_UPDATE({ channels: [] })).resolves.toMatchObject({ ok: true });
    expect(mockedSet).toHaveBeenCalledWith(CHANNELS_KEY, '[]');
  });
});
