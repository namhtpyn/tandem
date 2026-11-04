// MCP OAuth units (SPEC "MCP (registry + per-agent bindings) — OAuth per
// binding"): single-use state consume, the server-side code exchange (client
// creds + PKCE verifier + redirect_uri from the state row), encrypted token
// persistence, the silent refresh (fresh skips, expiring refreshes ONCE under
// concurrency, failure ships the stale token), best-effort revocation, and the
// registry-config token wipe. The live authorize→callback→dispatch loop is
// pinned by e2e mcp-oauth.spec.
import { randomBytes } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// vault crypto runs for real — a fixed key keeps the envelope roundtrip honest
process.env.TANDEM_VAULT_KEY = randomBytes(32).toString('base64');
process.env.TANDEM_PUBLIC_URL = 'https://tandem.example.com';

const h = vi.hoisted(() => ({
  serverRows: [] as Array<Record<string, unknown>>,
  bindingRows: [] as Array<Record<string, unknown>>,
  secretRows: [] as Array<Record<string, unknown>>,
  tokenRows: [] as Array<Record<string, unknown>>,
  stateReturn: [] as Array<Record<string, unknown>>,
  insertedStates: [] as Array<Record<string, unknown>>,
  deletedTokenBindingIds: [] as string[],
  fetchCalls: [] as Array<{ url: string; body: string }>,
  warns: [] as string[], // #291 F13: the refresh-warn path is the rate-limit map's observable surface
}));

// consola is mocked ONLY to record warn lines — warnRefreshFailure's rate-limit
// state (refreshWarnedAt) is module-private, so the warn count is the observable
vi.mock('consola', () => {
  const tag = {
    warn: (msg: unknown) => h.warns.push(String(msg)),
    error: () => {},
    success: () => {},
    info: () => {},
    start: () => {},
    debug: () => {},
    trace: () => {},
  };
  return { consola: { withTag: () => tag, ...tag } };
});

vi.mock('../../server/db/index', () => {
  return {
    asDb: (x: unknown) => x,
    db: {
      query: new Proxy(
        {},
        {
          get: (_t, name: string) => ({
            findMany: async (args?: { where?: Record<string, unknown>; columns?: Record<string, unknown> }) => {
              const w = (args?.where ?? {}) as Record<string, { eq?: string; in?: string[] }>;
              if (name === 'mcpServers') return h.serverRows;
              if (name === 'mcpOauthTokens') {
                return h.tokenRows.filter((r) => !w.bindingId?.eq || r.bindingId === w.bindingId.eq);
              }
              if (name === 'mcpServerBindings') {
                return h.bindingRows
                  .filter((r) => (!w.id?.eq || r.id === w.id.eq) && (!w.serverId?.eq || r.serverId === w.serverId.eq))
                  .map((r) => ({ ...r, server: h.serverRows.find((s) => s.id === r.serverId) ?? null }));
              }
              if (name === 'vaultSecrets') {
                return h.secretRows.filter((r) => !w.id?.in || (w.id.in as string[]).includes(r.id as string));
              }
              return [];
            },
          }),
        },
      ),
      insert: () => ({
        values: (values: Record<string, unknown>) => ({
          onConflictDoUpdate: async ({ set }: { set: Record<string, unknown> }) => {
            const id = set.bindingId as string;
            const row = h.tokenRows.find((r) => r.bindingId === id);
            if (row) Object.assign(row, set);
            else h.tokenRows.push({ ...values, ...set });
          },
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve().then(() => {
              h.insertedStates.push(values);
              res(undefined);
            }, rej),
        }),
      }),
      // refresh persistence is UPDATE-ONLY — applies to the single scripted row;
      // an empty table returns zero rows (the wiped-row race)
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              const row = h.tokenRows[0];
              if (!row) return [];
              Object.assign(row, values);
              return [{ id: row.id ?? 'tok-1' }];
            },
          }),
        }),
      }),
      delete: () => ({
        where: () => ({
          returning: async () => {
            // scripted consume — the state row IS the proof under test
            return h.stateReturn;
          },
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve().then(() => {
              // token-row deletes carry no returning (revoke/wipe paths)
              h.deletedTokenBindingIds.push('token');
              res(undefined);
            }, rej),
        }),
      }),
    },
  };
});

import {
  getFreshAccessToken,
  handleOauthCallback,
  oauthConfigFingerprint,
  oauthRedirectUri,
  oauthStatusFor,
  revokeOauthTokens,
  startOauthConnect,
  wipeOauthTokensForServer,
} from '../../server/domains/mcp/mcp-oauth.service';
import { decryptSecret, encryptSecret } from '../../server/domains/vault/secret/secret-crypto.service';

const BINDING_ID = 'b-1';
const SERVER_ID = 's-1';

/** the canonical oauth server contract these units run against */
const SERVER_CONFIG = {
  authKind: 'oauth',
  oauthAuthorizeUrl: 'https://provider.example.com/authorize',
  oauthTokenUrl: 'https://provider.example.com/token',
  oauthRevocationUrl: 'https://provider.example.com/revoke',
  oauthClientId: 'client-123',
  oauthClientSecretId: 'sec-1',
  oauthScopes: 'read write',
};
const CONFIG_FP = oauthConfigFingerprint(SERVER_CONFIG);

function seedOauthServer(overrides: Record<string, unknown> = {}) {
  h.serverRows.length = 0;
  h.serverRows.push({
    id: SERVER_ID,
    authKind: 'oauth',
    oauthAuthorizeUrl: 'https://provider.example.com/authorize',
    oauthTokenUrl: 'https://provider.example.com/token',
    oauthRevocationUrl: 'https://provider.example.com/revoke',
    oauthScopes: 'read write',
    oauthClientId: 'client-123',
    oauthClientSecretId: 'sec-1',
    ...overrides,
  });
}

function seedBinding(serverId = SERVER_ID) {
  h.bindingRows.length = 0;
  h.bindingRows.push({ id: BINDING_ID, serverId });
}

function tokenJson(over: Record<string, unknown> = {}) {
  return {
    access_token: 'at-new',
    refresh_token: 'rt-new',
    expires_in: 3600,
    scope: 'read write',
    ...over,
  };
}

beforeEach(() => {
  h.serverRows.length = 0;
  h.bindingRows.length = 0;
  h.secretRows.length = 0;
  h.tokenRows.length = 0;
  h.stateReturn = [];
  h.insertedStates.length = 0;
  h.deletedTokenBindingIds.length = 0;
  h.fetchCalls.length = 0;
  h.warns.length = 0;
  vi.unstubAllGlobals();
});

describe('oauthRedirectUri', () => {
  it('derives from TANDEM_PUBLIC_URL with request-origin fallback', () => {
    expect(oauthRedirectUri()).toBe('https://tandem.example.com/api/mcp/oauth/callback');
    process.env.TANDEM_PUBLIC_URL = '';
    expect(oauthRedirectUri('http://local:4100')).toBe('http://local:4100/api/mcp/oauth/callback');
    process.env.TANDEM_PUBLIC_URL = 'https://tandem.example.com';
  });
});

describe('startOauthConnect', () => {
  it('builds the PKCE authorize URL + persists the single-use state row', async () => {
    seedOauthServer();
    seedBinding();
    const { authorizeUrl } = await startOauthConnect({ employeeId: 'e-1', serverId: SERVER_ID });
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://provider.example.com/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe('https://tandem.example.com/api/mcp/oauth/callback');
    expect(url.searchParams.get('scope')).toBe('read write');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    const state = url.searchParams.get('state');
    expect(state).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(h.insertedStates).toHaveLength(1);
    expect(h.insertedStates[0]?.id).toBe(state);
    expect(h.insertedStates[0]?.bindingId).toBe(BINDING_ID);
    expect(h.insertedStates[0]?.redirectUri).toBe('https://tandem.example.com/api/mcp/oauth/callback');
    // the state binds the config contract it was minted under (64-hex sha256)
    expect(h.insertedStates[0]?.configFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses non-oauth registry entries and missing bindings', async () => {
    seedOauthServer({ authKind: 'none' });
    seedBinding();
    await expect(startOauthConnect({ employeeId: 'e-1', serverId: SERVER_ID })).rejects.toThrow(/not OAuth-configured/);
    seedOauthServer();
    h.bindingRows.length = 0;
    await expect(startOauthConnect({ employeeId: 'e-1', serverId: SERVER_ID })).rejects.toThrow(/binding not found/);
  });
});

describe('handleOauthCallback', () => {
  it('exchanges the code server-side and stores ENCRYPTED tokens on the binding', async () => {
    seedOauthServer();
    seedBinding();
    const secretEnc = encryptSecret('super-secret-client');
    h.secretRows.push({ id: 'sec-1', ciphertext: secretEnc });
    h.stateReturn = [
      {
        bindingId: BINDING_ID,
        codeVerifier: 'verifier-abc',
        redirectUri: 'https://tandem.example.com/api/mcp/oauth/callback',
        expiresAt: new Date(Date.now() + 60_000),
        // minted under THIS config — the fingerprint check must pass
        configFingerprint: CONFIG_FP,
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: { body?: string }) => {
        h.fetchCalls.push({ url: String(url), body: init?.body ?? '' });
        return new Response(JSON.stringify(tokenJson()), { status: 200 });
      }),
    );
    await handleOauthCallback({ code: 'the-code', state: 'st-1' });
    expect(h.fetchCalls).toHaveLength(1);
    const params = new URLSearchParams(h.fetchCalls[0]?.body);
    expect(h.fetchCalls[0]?.url).toBe('https://provider.example.com/token');
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('the-code');
    expect(params.get('code_verifier')).toBe('verifier-abc');
    expect(params.get('redirect_uri')).toBe('https://tandem.example.com/api/mcp/oauth/callback');
    expect(params.get('client_id')).toBe('client-123');
    expect(params.get('client_secret')).toBe('super-secret-client');
    expect(h.tokenRows).toHaveLength(1);
    const row = h.tokenRows[0] as Record<string, unknown>;
    expect(row.bindingId).toBe(BINDING_ID);
    // write-only law: ciphertext on the row, plaintext ONLY via decryptSecret
    expect(row.accessTokenEnc).not.toBe('at-new');
    expect(decryptSecret(row.accessTokenEnc as string)).toBe('at-new');
    expect(decryptSecret(row.refreshTokenEnc as string)).toBe('rt-new');
    expect(row.scope).toBe('read write');
    expect((row.expiresAt as Date).getTime()).toBeGreaterThan(Date.now() + 3500_000);
  });

  it('refuses a callback whose state was minted under a DIFFERENT oauth config', async () => {
    seedOauthServer();
    seedBinding();
    h.secretRows.push({ id: 'sec-1', ciphertext: encryptSecret('super-secret-client') });
    h.stateReturn = [
      {
        bindingId: BINDING_ID,
        codeVerifier: 'v',
        redirectUri: 'https://x/cb',
        expiresAt: new Date(Date.now() + 60_000),
        configFingerprint: 'minted-under-the-old-contract',
      },
    ];
    vi.stubGlobal('fetch', vi.fn());
    await expect(handleOauthCallback({ code: 'c', state: 'st-1' })).rejects.toThrow(
      /changed since the connect started/,
    );
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.tokenRows).toHaveLength(0);
  });

  it('rejects an unknown/already-used state before any exchange', async () => {
    seedOauthServer();
    seedBinding();
    h.stateReturn = [];
    vi.stubGlobal('fetch', vi.fn());
    await expect(handleOauthCallback({ code: 'c', state: 'st-x' })).rejects.toThrow(/already-used state/);
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.tokenRows).toHaveLength(0);
  });

  it('rejects an expired state', async () => {
    seedOauthServer();
    seedBinding();
    h.stateReturn = [
      { bindingId: BINDING_ID, codeVerifier: 'v', redirectUri: 'https://x/cb', expiresAt: new Date(Date.now() - 1000) },
    ];
    vi.stubGlobal('fetch', vi.fn());
    await expect(handleOauthCallback({ code: 'c', state: 'st-1' })).rejects.toThrow(/expired/);
    expect(h.fetchCalls).toHaveLength(0);
  });
});

describe('getFreshAccessToken (silent refresh + read-time contract guard)', () => {
  it('returns the decrypted access token without a fetch when fresh', async () => {
    h.tokenRows.push({
      bindingId: BINDING_ID,
      accessTokenEnc: encryptSecret('at-fresh'),
      expiresAt: new Date(Date.now() + 3_600_000),
      configFingerprint: CONFIG_FP,
    });
    vi.stubGlobal('fetch', vi.fn());
    expect(await getFreshAccessToken(BINDING_ID, SERVER_CONFIG)).toBe('at-fresh');
    expect(h.fetchCalls).toHaveLength(0);
  });

  it('returns null when no token row exists', async () => {
    expect(await getFreshAccessToken(BINDING_ID, SERVER_CONFIG)).toBeNull();
  });

  it('a token row minted under a DIFFERENT config is inert — deleted on read, never shipped', async () => {
    h.tokenRows.push({
      bindingId: BINDING_ID,
      accessTokenEnc: encryptSecret('at-old-contract'),
      expiresAt: new Date(Date.now() + 3_600_000),
      configFingerprint: 'minted-under-the-old-contract',
    });
    vi.stubGlobal('fetch', vi.fn());
    expect(await getFreshAccessToken(BINDING_ID, SERVER_CONFIG)).toBeNull();
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.deletedTokenBindingIds).toHaveLength(1); // inert row deleted on sight
  });

  it('refreshes an expiring token exactly once under concurrent callers', async () => {
    h.bindingRows.push({ id: BINDING_ID, serverId: SERVER_ID });
    seedOauthServer();
    h.secretRows.push({ id: 'sec-1', ciphertext: encryptSecret('super-secret-client') });
    h.tokenRows.push({
      bindingId: BINDING_ID,
      accessTokenEnc: encryptSecret('at-stale'),
      refreshTokenEnc: encryptSecret('rt-old'),
      expiresAt: new Date(Date.now() + 10_000), // inside the 60s skew window
      configFingerprint: CONFIG_FP,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: { body?: string }) => {
        h.fetchCalls.push({ url: String(url), body: init?.body ?? '' });
        return new Response(JSON.stringify(tokenJson()), { status: 200 });
      }),
    );
    const [a, b] = await Promise.all([
      getFreshAccessToken(BINDING_ID, SERVER_CONFIG),
      getFreshAccessToken(BINDING_ID, SERVER_CONFIG),
    ]);
    expect(a).toBe('at-new');
    expect(b).toBe('at-new');
    expect(h.fetchCalls).toHaveLength(1); // single-flight per binding
    const params = new URLSearchParams(h.fetchCalls[0]?.body);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('rt-old');
    expect(params.get('client_secret')).toBe('super-secret-client');
    // refreshed tokens persisted (rotation kept the old refresh when absent)
    const row = h.tokenRows[0] as Record<string, unknown>;
    expect(decryptSecret(row.accessTokenEnc as string)).toBe('at-new');
    expect(row.configFingerprint).toBe(CONFIG_FP);
  });

  it('a refresh landing after a config wipe persists NOTHING (UPDATE-only row)', async () => {
    h.bindingRows.push({ id: BINDING_ID, serverId: SERVER_ID });
    seedOauthServer();
    h.secretRows.push({ id: 'sec-1', ciphertext: encryptSecret('super-secret-client') });
    h.tokenRows.push({
      bindingId: BINDING_ID,
      accessTokenEnc: encryptSecret('at-stale'),
      refreshTokenEnc: encryptSecret('rt-old'),
      expiresAt: new Date(Date.now() - 1000),
      configFingerprint: CONFIG_FP,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        h.fetchCalls.push({ url: String(url), body: '' });
        // the wipe deletes the row WHILE the token POST is in flight
        h.tokenRows.length = 0;
        return new Response(JSON.stringify(tokenJson()), { status: 200 });
      }),
    );
    // the fresh token may ship for THIS call, but no row may be re-created
    await getFreshAccessToken(BINDING_ID, SERVER_CONFIG);
    expect(h.tokenRows).toHaveLength(0);
  });

  it('ships the STALE token when the refresh fails — dispatch never breaks', async () => {
    h.bindingRows.push({ id: BINDING_ID, serverId: SERVER_ID });
    seedOauthServer();
    h.tokenRows.push({
      bindingId: BINDING_ID,
      accessTokenEnc: encryptSecret('at-stale'),
      refreshTokenEnc: encryptSecret('rt-old'),
      expiresAt: new Date(Date.now() - 1000),
      configFingerprint: CONFIG_FP,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        h.fetchCalls.push({ url: String(url), body: '' });
        return new Response('server error line', { status: 500 });
      }),
    );
    expect(await getFreshAccessToken(BINDING_ID, SERVER_CONFIG)).toBe('at-stale');
    expect(h.fetchCalls).toHaveLength(1);
  });
});

describe('revokeOauthTokens (unbind = revoke)', () => {
  it('POSTs the revocation endpoint for BOTH tokens then deletes the token row', async () => {
    h.bindingRows.push({ id: BINDING_ID, serverId: SERVER_ID });
    seedOauthServer();
    h.tokenRows.push({
      bindingId: BINDING_ID,
      accessTokenEnc: encryptSecret('at-gone'),
      refreshTokenEnc: encryptSecret('rt-gone'),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: { body?: string }) => {
        h.fetchCalls.push({ url: String(url), body: init?.body ?? '' });
        return new Response('{}', { status: 200 });
      }),
    );
    await revokeOauthTokens(BINDING_ID);
    // the refresh token is the durable grant — it revokes FIRST, independently
    expect(h.fetchCalls).toHaveLength(2);
    expect(h.fetchCalls[0]?.url).toBe('https://provider.example.com/revoke');
    const first = new URLSearchParams(h.fetchCalls[0]?.body);
    const second = new URLSearchParams(h.fetchCalls[1]?.body);
    expect(first.get('token')).toBe('rt-gone');
    expect(second.get('token')).toBe('at-gone');
    expect(first.get('client_id')).toBe('client-123');
    expect(h.deletedTokenBindingIds).toHaveLength(1);
  });

  it('still deletes the row when the revoke call fails (best-effort by contract)', async () => {
    h.bindingRows.push({ id: BINDING_ID, serverId: SERVER_ID });
    seedOauthServer();
    h.tokenRows.push({ bindingId: BINDING_ID, accessTokenEnc: encryptSecret('at-gone') });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('network down'))),
    );
    await expect(revokeOauthTokens(BINDING_ID)).resolves.toBeUndefined();
    expect(h.deletedTokenBindingIds).toHaveLength(1);
  });

  it('returns null (never throws) on an undecryptable token row', async () => {
    h.tokenRows.push({
      bindingId: BINDING_ID,
      accessTokenEnc: 'v1:garbage',
      expiresAt: new Date(Date.now() + 3_600_000),
      configFingerprint: CONFIG_FP,
    });
    vi.stubGlobal('fetch', vi.fn());
    expect(await getFreshAccessToken(BINDING_ID, SERVER_CONFIG)).toBeNull();
    expect(h.fetchCalls).toHaveLength(0);
  });
});

describe('oauthStatusFor (masked status obeys the inert-row law)', () => {
  it('a fingerprint-matching row reports connected with masked expiry', async () => {
    const expires = new Date(Date.now() + 3_600_000);
    h.tokenRows.push({ bindingId: BINDING_ID, accessTokenEnc: 'x', expiresAt: expires, configFingerprint: CONFIG_FP });
    const status = await oauthStatusFor(BINDING_ID, SERVER_CONFIG);
    expect(status.connected).toBe(true);
    expect(status.expiresAt).toBe(expires.toISOString());
  });

  it('an inert row (stale fingerprint) reports NOT connected and is deleted on the read', async () => {
    h.tokenRows.push({
      bindingId: BINDING_ID,
      accessTokenEnc: 'x',
      expiresAt: new Date(Date.now() + 3_600_000),
      configFingerprint: 'minted-under-the-old-contract',
    });
    const status = await oauthStatusFor(BINDING_ID, SERVER_CONFIG);
    expect(status.connected).toBe(false);
    expect(status.expiresAt).toBeNull();
    expect(h.deletedTokenBindingIds).toHaveLength(1);
  });
});

describe('wipeOauthTokensForServer (registry OAuth-config edit)', () => {
  it('deletes token rows AND pending connect state for every binding of that server', async () => {
    h.bindingRows.push({ id: 'b-1', serverId: SERVER_ID }, { id: 'b-2', serverId: SERVER_ID });
    await wipeOauthTokensForServer(SERVER_ID);
    // 2 bindings × (tokens + states) = 4 deletes
    expect(h.deletedTokenBindingIds).toHaveLength(4);
  });
});

describe('refreshWarnedAt eviction (#291 F13)', () => {
  const stubFailingRefresh = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        h.fetchCalls.push({ url: String(url), body: '' });
        return new Response('server error line', { status: 500 });
      }),
    );
  const seedStaleRow = (bindingId = BINDING_ID) =>
    h.tokenRows.push({
      bindingId,
      accessTokenEnc: encryptSecret('at-stale'),
      refreshTokenEnc: encryptSecret('rt-old'),
      expiresAt: new Date(Date.now() - 1000),
      configFingerprint: CONFIG_FP,
    });

  it('revoke evicts the rate-limit state — a re-connected binding warns from scratch', async () => {
    // a binding id NO earlier test ever warned for: the map is module state and
    // entries live 5 min — a shared id would inherit an earlier test's arm
    const BID = 'b-f13-revoke';
    h.bindingRows.push({ id: BID, serverId: SERVER_ID });
    seedOauthServer();
    seedStaleRow(BID);
    stubFailingRefresh();
    // failure 1 warns + arms the 5-min rate limit; failure 2 inside the window is silenced
    await getFreshAccessToken(BID, SERVER_CONFIG);
    expect(h.warns).toHaveLength(1);
    await getFreshAccessToken(BID, SERVER_CONFIG);
    expect(h.warns).toHaveLength(1);
    // unbind = revoke: the eviction frees the state — pre-fix the entry lived forever
    await revokeOauthTokens(BID);
    expect(h.deletedTokenBindingIds.length).toBeGreaterThan(0);
    // the binding re-connects (fresh row, SAME binding id): a new failure warns anew
    h.tokenRows.length = 0;
    seedStaleRow(BID);
    await getFreshAccessToken(BID, SERVER_CONFIG);
    expect(h.warns).toHaveLength(2);
  });

  it('the registry-config wipe evicts warn state for the wiped bindings too', async () => {
    const BID = 'b-f13-wipe';
    h.bindingRows.push({ id: BID, serverId: SERVER_ID });
    seedOauthServer();
    seedStaleRow(BID);
    stubFailingRefresh();
    await getFreshAccessToken(BID, SERVER_CONFIG); // warn + arm
    expect(h.warns).toHaveLength(1);
    await wipeOauthTokensForServer(SERVER_ID);
    h.tokenRows.length = 0;
    seedStaleRow(BID);
    await getFreshAccessToken(BID, SERVER_CONFIG);
    expect(h.warns).toHaveLength(2); // pre-fix: silenced by the never-evicted entry
  });
});
