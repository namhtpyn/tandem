// MCP OAuth per binding (#270 slice 2, SPEC "MCP (registry + per-agent
// bindings) — OAuth per binding"): the Tandem-hosted authorization-code + PKCE
// flow, the per-binding token store (AES-GCM vault envelope — decrypted
// server-side at dispatch/probe ONLY), the silent refresh the dispatch path
// rides, and the best-effort revocation an unbind performs. The single-use
// state row IS the authorization proof for the provider's callback.
import { createHash, randomBytes } from 'node:crypto';

import { consola } from 'consola';
import { eq, lt } from 'drizzle-orm';

import { db } from '../../db/index';
import { mcpOauthStates, mcpOauthTokens } from '../../db/schema';
import { decryptSecret, encryptSecret } from '../vault/secret/secret-crypto.service';

/** a token expiring within this window refreshes BEFORE it rides a dispatch */
const REFRESH_SKEW_MS = 60_000;
const STATE_TTL_MS = 10 * 60_000;
const TOKEN_HTTP_TIMEOUT_MS = 15_000;
const REVOKE_HTTP_TIMEOUT_MS = 5_000;

const b64url = (buf: Buffer) => buf.toString('base64url');

export type OauthServerConfig = {
  authKind: string;
  oauthAuthorizeUrl: string | null;
  oauthTokenUrl: string | null;
  oauthRevocationUrl: string | null;
  oauthClientId: string | null;
  oauthClientSecretId: string | null;
  oauthScopes: string | null;
};

/** redirect_uri is deterministic from the instance public URL (env with a
 * request-origin fallback) so the provider registration is stable */
export function oauthRedirectUri(origin?: string | null): string {
  const base = (process.env.TANDEM_PUBLIC_URL || origin || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/api/mcp/oauth/callback`;
}

/** request-origin for the connect mint — proxy headers first, host fallback
 * (the same derivation the legacy REST connect route performed before #278
 * moved the mint behind the admin-only oRPC POST) */
export function oauthConnectOrigin(headers: Headers | undefined | null): string {
  const h = headers ?? new Headers();
  const host =
    String(h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000')
      .split(',')[0]
      ?.trim() || 'localhost:3000';
  const proto =
    String(h.get('x-forwarded-proto') ?? 'http')
      .split(',')[0]
      ?.trim() || 'http';
  return `${proto}://${host}`;
}

/** single-use state consume: the row is the proof — deleted on FIRST use */
async function consumeState(
  stateId: string,
): Promise<{ bindingId: string; codeVerifier: string; redirectUri: string; configFingerprint: string }> {
  const deleted = await db.delete(mcpOauthStates).where(eq(mcpOauthStates.id, stateId)).returning();
  const row = deleted[0];
  if (!row) throw new Error('unknown or already-used state');
  if (row.expiresAt.getTime() < Date.now()) throw new Error('state expired — start the connect again');
  return {
    bindingId: row.bindingId,
    codeVerifier: row.codeVerifier,
    redirectUri: row.redirectUri,
    configFingerprint: row.configFingerprint,
  };
}

/** binding + its server's oauth config, or null (the server join is typed
 * non-null — the FK guarantees it) */
type OauthBindingRow = {
  id: string;
  server: {
    name: string;
    authKind: string;
    oauthAuthorizeUrl: string | null;
    oauthTokenUrl: string | null;
    oauthRevocationUrl: string | null;
    oauthClientId: string | null;
    oauthScopes: string | null;
  };
};

async function findOauthBinding(employeeId: string, serverId: string): Promise<OauthBindingRow | null> {
  const rows = await db.query.mcpServerBindings.findMany({
    where: { employeeId: { eq: employeeId }, serverId: { eq: serverId } },
    with: { server: true },
  });
  return (rows[0] as OauthBindingRow | undefined) ?? null;
}

/** client credential form params (client_id always; client_secret decrypted
 * from the registry entry's confidential-client vault ref when set) */
async function clientAuthParams(server: OauthServerConfig): Promise<Record<string, string>> {
  const params: Record<string, string> = {};
  if (server.oauthClientId) params.client_id = server.oauthClientId;
  if (server.oauthClientSecretId) {
    const rows = await db.query.vaultSecrets.findMany({
      columns: { ciphertext: true },
      where: { id: { eq: server.oauthClientSecretId } },
    });
    const ciphertext = rows[0]?.ciphertext;
    if (ciphertext) params.client_secret = decryptSecret(ciphertext);
  }
  return params;
}

async function loadOauthServerConfig(serverId: string): Promise<OauthServerConfig> {
  const rows = await db.query.mcpServers.findMany({ where: { id: { eq: serverId } } });
  const server = rows[0];
  return {
    authKind: server?.authKind ?? 'none',
    oauthAuthorizeUrl: server?.oauthAuthorizeUrl ?? null,
    oauthTokenUrl: server?.oauthTokenUrl ?? null,
    oauthRevocationUrl: server?.oauthRevocationUrl ?? null,
    oauthClientId: server?.oauthClientId ?? null,
    oauthClientSecretId: server?.oauthClientSecretId ?? null,
    oauthScopes: server?.oauthScopes ?? null,
  };
}

type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };

/** RFC 6749 token-endpoint POST (form-encoded, 15s cap) — first error line only */
async function tokenRequest(tokenUrl: string, params: Record<string, string>): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(TOKEN_HTTP_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`token endpoint unreachable: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
  }
  if (!res.ok) {
    const text = (await res.text()).split('\n')[0] ?? '';
    throw new Error(`token endpoint HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as Partial<TokenResponse> & { error?: string; error_description?: string };
  if (!json.access_token) {
    const why = json.error
      ? `${json.error}${json.error_description ? `: ${json.error_description}` : ''}`
      : 'no access_token in response';
    throw new Error(`token endpoint returned ${why}`);
  }
  return json as TokenResponse;
}

async function persistTokens(bindingId: string, r: TokenResponse, configFingerprint: string) {
  const values = {
    bindingId,
    accessTokenEnc: encryptSecret(r.access_token),
    refreshTokenEnc: r.refresh_token ? encryptSecret(r.refresh_token) : null,
    expiresAt: typeof r.expires_in === 'number' ? new Date(Date.now() + r.expires_in * 1000) : null,
    scope: r.scope ?? '',
    configFingerprint,
    updatedAt: new Date(),
  };
  await db.insert(mcpOauthTokens).values(values).onConflictDoUpdate({ target: mcpOauthTokens.bindingId, set: values });
}

/** REFRESH persistence is UPDATE-ONLY: a refresh never CREATES a token row —
 * the callback owns creation. A config wipe deletes the row atomically, so a
 * refresh response landing after the wipe updates 0 rows and can never
 * resurrect old-contract tokens (SPEC invariant, race-free by construction). */
async function updateTokens(bindingId: string, r: TokenResponse, configFingerprint: string): Promise<boolean> {
  const updated = await db
    .update(mcpOauthTokens)
    .set({
      accessTokenEnc: encryptSecret(r.access_token),
      refreshTokenEnc: r.refresh_token ? encryptSecret(r.refresh_token) : null,
      expiresAt: typeof r.expires_in === 'number' ? new Date(Date.now() + r.expires_in * 1000) : null,
      scope: r.scope ?? '',
      configFingerprint,
      updatedAt: new Date(),
    })
    .where(eq(mcpOauthTokens.bindingId, bindingId))
    .returning({ id: mcpOauthTokens.id });
  return updated.length > 0;
}

/** config fingerprint bound into the state row at connect and re-verified at
 * the callback — a pre-edit callback can never complete against a changed
 * contract (SPEC: old-contract tokens never survive a config change). Uses the
 * secret REF, not its value: a vault-side rotation is handled by the
 * rotation wipe in the secret service (same invariant, own trigger). */
export function oauthConfigFingerprint(config: OauthServerConfig): string {
  return createHash('sha256')
    .update(
      [
        config.authKind,
        config.oauthAuthorizeUrl ?? '',
        config.oauthTokenUrl ?? '',
        config.oauthRevocationUrl ?? '',
        config.oauthClientId ?? '',
        config.oauthClientSecretId ?? '',
        config.oauthScopes ?? '',
      ].join('|'),
    )
    .digest('hex');
}

/** admin-only: build the provider authorize URL (302 target) + the single-use
 * state row; requires an existing binding on an oauth-configured server */
export async function startOauthConnect(input: { employeeId: string; serverId: string; origin?: string | null }) {
  const binding = await findOauthBinding(input.employeeId, input.serverId);
  if (!binding) throw new Error('binding not found');
  const server = binding.server;
  if (server.authKind !== 'oauth') throw new Error('registry entry is not OAuth-configured');
  if (!server.oauthAuthorizeUrl || !server.oauthTokenUrl || !server.oauthClientId) {
    throw new Error('registry entry is missing OAuth endpoints — complete the OAuth config first');
  }
  // opportunistic TTL sweep: abandoned connects (closed popup, provider-error
  // return) leave state rows — every new connect clears the expired ones
  await db.delete(mcpOauthStates).where(lt(mcpOauthStates.expiresAt, new Date()));
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(64));
  const redirectUri = oauthRedirectUri(input.origin);
  const serverConfig = await loadOauthServerConfig(input.serverId);
  await db.insert(mcpOauthStates).values({
    id: state,
    bindingId: binding.id,
    codeVerifier: verifier,
    redirectUri,
    configFingerprint: oauthConfigFingerprint(serverConfig),
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });
  const url = new URL(server.oauthAuthorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', server.oauthClientId);
  url.searchParams.set('redirect_uri', redirectUri);
  if (server.oauthScopes) url.searchParams.set('scope', server.oauthScopes);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()));
  url.searchParams.set('code_challenge_method', 'S256');
  return { authorizeUrl: url.toString(), serverName: server.name };
}

/** provider callback: consume the state, exchange the code server-side, store
 * the binding's tokens; the thrown message lands on the result page. The
 * server's CURRENT config rules — a state minted before an OAuth-config edit
 * (or a kind flip) can never complete against the old contract. */
export async function handleOauthCallback(input: { code: string; state: string }) {
  const state = await consumeState(input.state);
  const bindingRows = await db.query.mcpServerBindings.findMany({
    columns: { serverId: true },
    where: { id: { eq: state.bindingId } },
  });
  const binding = bindingRows[0];
  if (!binding) throw new Error('binding vanished before the code exchange');
  const server = await loadOauthServerConfig(binding.serverId);
  if (server.authKind !== 'oauth') throw new Error('registry entry is no longer OAuth-configured');
  if (!server.oauthTokenUrl) throw new Error('registry entry lost its token endpoint');
  // contract guard: the config must be byte-identical to what the state was
  // minted under — a config edit between connect and callback invalidates the flow
  if (oauthConfigFingerprint(server) !== state.configFingerprint) {
    throw new Error('registry entry changed since the connect started — start the connect again');
  }
  const token = await tokenRequest(server.oauthTokenUrl, {
    ...(await clientAuthParams(server)),
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: state.redirectUri,
    code_verifier: state.codeVerifier,
  });
  // re-check AFTER the multi-second exchange: a config change committing while
  // the POST was in flight must not resurrect old-contract tokens
  const serverAfterExchange = await loadOauthServerConfig(binding.serverId);
  if (
    serverAfterExchange.authKind !== 'oauth' ||
    !serverAfterExchange.oauthTokenUrl ||
    oauthConfigFingerprint(serverAfterExchange) !== state.configFingerprint
  ) {
    throw new Error('registry entry changed during the exchange — start the connect again');
  }
  await persistTokens(state.bindingId, token, state.configFingerprint);
}

/** map a registry row (or a binding's joined server) onto the OauthServerConfig
 * the flow helpers consume — one shape, no drift */
export function oauthConfigFromServerRow(server: {
  authKind: string;
  oauthAuthorizeUrl: string | null;
  oauthTokenUrl: string | null;
  oauthRevocationUrl: string | null;
  oauthClientId: string | null;
  oauthClientSecretId: string | null;
  oauthScopes: string | null;
}): OauthServerConfig {
  return {
    authKind: server.authKind,
    oauthAuthorizeUrl: server.oauthAuthorizeUrl,
    oauthTokenUrl: server.oauthTokenUrl,
    oauthRevocationUrl: server.oauthRevocationUrl,
    oauthClientId: server.oauthClientId,
    oauthClientSecretId: server.oauthClientSecretId,
    oauthScopes: server.oauthScopes,
  };
}

/** masked read model for binding rows — never the tokens. The inert-row law
 * applies here too: a row whose fingerprint no longer matches the server
 * config reports NOT connected and is deleted on this read (never ships,
 * never lingers as a dead "Connected" badge). */
export async function oauthStatusFor(
  bindingId: string,
  server: OauthServerConfig,
): Promise<{ connected: boolean; expiresAt: string | null }> {
  const rows = await db.query.mcpOauthTokens.findMany({
    columns: { expiresAt: true, configFingerprint: true },
    where: { bindingId: { eq: bindingId } },
  });
  const row = rows[0];
  if (!row) return { connected: false, expiresAt: null };
  if (row.configFingerprint !== oauthConfigFingerprint(server)) {
    await db.delete(mcpOauthTokens).where(eq(mcpOauthTokens.bindingId, bindingId));
    refreshWarnedAt.delete(bindingId); // #291 r2 review: token rows gone — no warn state may outlive them
    return { connected: false, expiresAt: null };
  }
  return { connected: true, expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null };
}

/**
 * SILENT REFRESH (dispatch/probe path): returns the binding's access token,
 * refreshing first when missing/expired/expiring within the skew window.
 * Single-flight per binding; a failed refresh NEVER throws — the stale access
 * token ships (null when none), the next dispatch re-arms.
 */
const refreshInFlight = new Map<string, Promise<string | null>>();

export async function getFreshAccessToken(bindingId: string, server: OauthServerConfig): Promise<string | null> {
  const rows = await db.query.mcpOauthTokens.findMany({ where: { bindingId: { eq: bindingId } } });
  const row = rows[0];
  if (!row) {
    // #291 r4: a refresh that read rows before a concurrent delete can still fail
    // AFTER that delete's eviction ran and re-arm the entry — the empty-table read
    // is the self-healing sweep: no token rows, no warn state may survive
    refreshWarnedAt.delete(bindingId);
    return null;
  }
  // READ-TIME CONTRACT GUARD: a token minted under a different config is inert —
  // delete it on sight and ship nothing (old-contract tokens can never ride a
  // dispatch, whatever write race the wipe path lost)
  if (row.configFingerprint !== oauthConfigFingerprint(server)) {
    await db.delete(mcpOauthTokens).where(eq(mcpOauthTokens.bindingId, bindingId));
    refreshWarnedAt.delete(bindingId); // #291 r2 review: token rows gone — no warn state may outlive them
    return null;
  }
  try {
    const access = decryptSecret(row.accessTokenEnc);
    if (!row.expiresAt || row.expiresAt.getTime() > Date.now() + REFRESH_SKEW_MS) return access;
  } catch {
    // undecryptable row (corrupt ciphertext / rotated key): fall through to the
    // guarded refresh — dispatch still ships nothing and NEVER throws
  }
  return refreshSingleFlight(bindingId, server);
}

function refreshSingleFlight(bindingId: string, server: OauthServerConfig): Promise<string | null> {
  let pending = refreshInFlight.get(bindingId);
  if (!pending) {
    pending = refreshBindingTokens(bindingId, server).finally(() => refreshInFlight.delete(bindingId));
    refreshInFlight.set(bindingId, pending);
  }
  return pending;
}

async function refreshBindingTokens(bindingId: string, server: OauthServerConfig): Promise<string | null> {
  const rows = await db.query.mcpOauthTokens.findMany({ where: { bindingId: { eq: bindingId } } });
  const row = rows[0];
  if (!row?.refreshTokenEnc) return null;
  // stale access decrypt is best-effort — the refresh grant needs only the
  // refresh token, so an undecryptable access ciphertext must not stop the re-arm
  let stale: string | null = null;
  try {
    stale = decryptSecret(row.accessTokenEnc);
  } catch {
    stale = null;
  }
  try {
    if (!server.oauthTokenUrl) throw new Error('no token endpoint');
    const refresh = decryptSecret(row.refreshTokenEnc);
    const token = await tokenRequest(server.oauthTokenUrl, {
      ...(await clientAuthParams(server)),
      grant_type: 'refresh_token',
      refresh_token: refresh,
    });
    // UPDATE-ONLY: a wiped row (config change committed mid-refresh) updates 0
    // rows — the fresh token ships for THIS dispatch and nothing is persisted
    await updateTokens(
      bindingId,
      {
        access_token: token.access_token,
        refresh_token: token.refresh_token ?? refresh,
        expires_in: token.expires_in,
        scope: token.scope,
      },
      oauthConfigFingerprint(server),
    );
    return token.access_token;
  } catch (e) {
    // stale token ships — dispatch must never break on a refresh failure; the
    // failure still leaves a rate-limited trace (a permanently failing binding
    // must not 401 silently forever)
    await warnRefreshFailure(bindingId, e);
    return stale;
  }
}

const REFRESH_WARN_INTERVAL_MS = 5 * 60_000;
const refreshWarnedAt = new Map<string, number>();
const log = consola.withTag('tandem');

/** rate-limited (once per binding per 5 min) trace of silent refresh failures.
 * Arms ONLY for bindings that still exist (#291 r5): a refresh that read its rows
 * before a concurrent unbind can fail AFTER the unbind's eviction ran — re-arming
 * would leave a dead binding's entry in the map forever, because no future read
 * ever sweeps it (the dispatch/probe paths only run for live bindings). */
async function warnRefreshFailure(bindingId: string, e: unknown) {
  try {
    const bindingRows = await db.query.mcpServerBindings.findMany({
      columns: { id: true },
      where: { id: { eq: bindingId } },
    });
    if (bindingRows.length === 0) return; // unbound mid-flight: nothing left to warn for
  } catch {
    /* the liveness probe is best-effort — never let it silence the warn */
  }
  const now = Date.now();
  const last = refreshWarnedAt.get(bindingId) ?? 0;
  if (now - last < REFRESH_WARN_INTERVAL_MS) return;
  refreshWarnedAt.set(bindingId, now);
  const message = (e instanceof Error ? e.message : String(e)).split('\n')[0];
  log.warn(`token refresh failed for binding ${bindingId} (stale token ships): ${message}`);
}

/** UNBIND = REVOKE: best-effort RFC 7009 revocation of BOTH tokens — the
 * DURABLE refresh token revokes FIRST and each POST stands alone, so a failed
 * access-token POST can never skip the grant that matters — then the token-row
 * delete; a failed revoke never blocks the unbind */
export async function revokeOauthTokens(bindingId: string): Promise<void> {
  try {
    const rows = await db.query.mcpOauthTokens.findMany({ where: { bindingId: { eq: bindingId } } });
    const row = rows[0];
    const bindingRows = await db.query.mcpServerBindings.findMany({
      columns: { serverId: true },
      where: { id: { eq: bindingId } },
    });
    const serverId = bindingRows[0]?.serverId;
    if (row && serverId) {
      const server = await loadOauthServerConfig(serverId);
      if (server.oauthRevocationUrl) {
        const clientParams = await clientAuthParams(server);
        const revocationUrl = server.oauthRevocationUrl;
        const revokeOne = async (token: string) => {
          await fetch(revocationUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
            body: new URLSearchParams({ ...clientParams, token }),
            signal: AbortSignal.timeout(REVOKE_HTTP_TIMEOUT_MS),
          });
        };
        // the refresh token is the durable grant — it goes first, independently
        if (row.refreshTokenEnc) {
          try {
            await revokeOne(decryptSecret(row.refreshTokenEnc));
          } catch {
            /* each revocation is individually best-effort */
          }
        }
        try {
          await revokeOne(decryptSecret(row.accessTokenEnc));
        } catch {
          /* each revocation is individually best-effort */
        }
      }
    }
  } catch {
    /* revocation is best-effort by contract */
  }
  // WARN-MAP EVICTION (#291 F13): a revoked/unbound binding can never refresh
  // again — its rate-limit entry would otherwise sit in the map forever
  refreshWarnedAt.delete(bindingId);
  await db.delete(mcpOauthTokens).where(eq(mcpOauthTokens.bindingId, bindingId));
}

/** employee removal cascades their bindings — revoke the provider grants
 * best-effort BEFORE the cascade deletes the rows (unbind = revoke holds on
 * every path that removes a binding) */
export async function revokeOauthTokensForEmployee(employeeId: string): Promise<void> {
  const rows = await db.query.mcpServerBindings.findMany({
    columns: { id: true },
    where: { employeeId: { eq: employeeId } },
  });
  for (const binding of rows) await revokeOauthTokens(binding.id);
}

/** registry OAuth-config changes wipe stored tokens AND pending connect state
 * for that server's bindings — tokens minted under an old client contract
 * never survive it, and a pre-edit callback can never complete against it.
 * Accepts a transaction client so the wipe commits atomically with the config
 * change (a failed save must not leave old tokens under a live new config). */
type DbClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function wipeOauthTokensForServer(serverId: string, client: DbClient | typeof db = db): Promise<void> {
  const rows = await client.query.mcpServerBindings.findMany({
    columns: { id: true },
    where: { serverId: { eq: serverId } },
  });
  for (const binding of rows) {
    refreshWarnedAt.delete(binding.id); // #291 F13: the registry-config wipe must not leak warn state either
    await client.delete(mcpOauthTokens).where(eq(mcpOauthTokens.bindingId, binding.id));
    await client.delete(mcpOauthStates).where(eq(mcpOauthStates.bindingId, binding.id));
  }
}
