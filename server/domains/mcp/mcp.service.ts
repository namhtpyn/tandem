// MCP domain (SPEC "MCP (registry + per-agent bindings)"): registry CRUD,
// per-agent bindings, binding-level probe, and the dispatch-plan builder the
// runner serializes onto ACP session/new + session/resume. The binding is the
// permission unit; the bound secret's plaintext IS the credential (sent
// verbatim as the Authorization header value) and is decrypted server-side at
// dispatch/probe ONLY — no API surface ever returns it.
import { eq } from 'drizzle-orm';

import { CHANGE_ACTION, CHANGE_RESOURCE } from '#shared/enums';
import { nonNull } from '#shared/utils/non-null';

import { db } from '../../db/index';
import { mcpServerBindings, mcpServers, vaultSecrets } from '../../db/schema';
import { ORPCError, publishChange } from '../kernel/kernel';
import { decryptSecret } from '../vault/secret/secret-crypto.service';
import {
  getFreshAccessToken,
  oauthConfigFromServerRow,
  oauthStatusFor,
  revokeOauthTokens,
  wipeOauthTokensForServer,
} from './mcp-oauth.service';

/** ACP wire shape for slice 1 — the SDK's own McpServer union (http member used) */
export type AcpMcpServer = import('@agentclientprotocol/sdk').McpServer;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toRegistryRow(r: typeof mcpServers.$inferSelect, bindingCount = 0) {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    notes: r.notes,
    authKind: r.authKind,
    oauth: {
      authorizeUrl: r.oauthAuthorizeUrl,
      tokenUrl: r.oauthTokenUrl,
      revocationUrl: r.oauthRevocationUrl,
      scopes: r.oauthScopes,
      clientId: r.oauthClientId,
      clientSecretId: r.oauthClientSecretId,
      // masked vault law: the session-tier read carries the ref + presence
      // only — never the secret's name (that inverts the vault picker)
      hasClientSecret: !!r.oauthClientSecretId,
    },
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    bindingCount,
  };
}

function toBindingRow(b: {
  id: string;
  serverId: string;
  secretId: string | null;
  lastProbeOk: boolean | null;
  lastProbeDetail: string | null;
  lastProbeAt: Date | null;
  server: { name: string; url: string };
  secret: { name: string; lastFour: string } | null;
}) {
  return {
    id: b.id,
    serverId: b.serverId,
    serverName: b.server.name,
    url: b.server.url,
    secretId: b.secretId,
    secretName: b.secret?.name ?? null,
    lastFour: b.secret?.lastFour ?? null,
    lastProbeOk: b.lastProbeOk,
    lastProbeDetail: b.lastProbeDetail,
    lastProbeAt: iso(b.lastProbeAt),
  };
}

type BindingWithRefs = {
  id: string;
  serverId: string;
  secretId: string | null;
  lastProbeOk: boolean | null;
  lastProbeDetail: string | null;
  lastProbeAt: Date | null;
  server: {
    name: string;
    url: string;
    authKind: string;
    oauthAuthorizeUrl: string | null;
    oauthTokenUrl: string | null;
    oauthRevocationUrl: string | null;
    oauthClientId: string | null;
    oauthClientSecretId: string | null;
    oauthScopes: string | null;
  };
  secret: { name: string; lastFour: string; ciphertext: string } | null;
};

/** load one binding (with server + secret refs) or null */
async function findBinding(employeeId: string, serverId: string): Promise<BindingWithRefs | null> {
  const rows = await db.query.mcpServerBindings.findMany({
    where: { employeeId: { eq: employeeId }, serverId: { eq: serverId } },
    with: { server: true, secret: true },
  });
  return (rows[0] as BindingWithRefs | undefined) ?? null;
}

const assertAiEmployee = async (employeeId: string) => {
  const rows = await db.query.aiEmployees.findMany({
    columns: { userId: true },
    where: { userId: { eq: employeeId } },
  });
  if (rows.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'employee is not an AI agent' });
};

export const assertRegistryEntry = async (serverId: string) => {
  const rows = await db.query.mcpServers.findMany({ where: { id: { eq: serverId } } });
  if (rows.length === 0) throw new ORPCError('NOT_FOUND', { message: 'MCP registry entry not found' });
};

const assertSecret = async (secretId: string) => {
  const rows = await db.select({ id: vaultSecrets.id }).from(vaultSecrets).where(eq(vaultSecrets.id, secretId));
  if (rows.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'credential secret not found' });
};

/** OAuth registry fields (slice 2): validated + normalized for insert/update.
 * authKind 'oauth' requires authorize/token urls + clientId; 'none' clears the
 * whole oauth block. */
export type RegistryOauthInput = {
  authKind?: 'none' | 'oauth';
  oauthAuthorizeUrl?: string | null;
  oauthTokenUrl?: string | null;
  oauthRevocationUrl?: string | null;
  oauthScopes?: string | null;
  oauthClientId?: string | null;
  oauthClientSecretId?: string | null;
};

const assertHttpUrl = (url: string, field: string) => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ORPCError('BAD_REQUEST', { message: `${field} must be an http/https URL` });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ORPCError('BAD_REQUEST', { message: `${field} must be an http/https URL` });
  }
};

const requireOauthField = (value: string | null | undefined, field: string) => {
  if (!value) throw new ORPCError('BAD_REQUEST', { message: `${field} is required for oauth servers` });
  return value;
};

const oauthCleared = {
  authKind: 'none',
  oauthAuthorizeUrl: null,
  oauthTokenUrl: null,
  oauthRevocationUrl: null,
  oauthScopes: null,
  oauthClientId: null,
  oauthClientSecretId: null,
};

/** whether the input carries ANY OAuth config key (an edit by contract) */
const oauthTouched = (input: RegistryOauthInput) =>
  input.authKind !== undefined ||
  input.oauthAuthorizeUrl !== undefined ||
  input.oauthTokenUrl !== undefined ||
  input.oauthRevocationUrl !== undefined ||
  input.oauthScopes !== undefined ||
  input.oauthClientId !== undefined ||
  input.oauthClientSecretId !== undefined;

/** OAuth config merge for create/update (slice 2): ANY authKind/oauth* key in
 * the input is an EDIT — the caller wipes that server's stored tokens + clears
 * its binding verdicts. Undefined fields keep the existing value; 'none'
 * clears the whole block; untouched input keeps the row (create → defaults). */
async function normalizeOauthFields(
  existing: Pick<
    typeof mcpServers.$inferSelect,
    | 'authKind'
    | 'oauthAuthorizeUrl'
    | 'oauthTokenUrl'
    | 'oauthRevocationUrl'
    | 'oauthScopes'
    | 'oauthClientId'
    | 'oauthClientSecretId'
  >,
  input: RegistryOauthInput,
): Promise<Partial<typeof mcpServers.$inferInsert>> {
  const touched = oauthTouched(input);
  const kind = input.authKind ?? (existing.authKind as 'none' | 'oauth');
  if (!touched) return {};
  if (kind === 'none') return { ...oauthCleared };
  // the required trio: an explicit null is a CLEAR attempt on a required field —
  // rejected 400, never silently kept from the existing row
  const authorizeUrl = requireOauthField(
    input.oauthAuthorizeUrl !== undefined ? input.oauthAuthorizeUrl : existing.oauthAuthorizeUrl,
    'oauthAuthorizeUrl',
  );
  const tokenUrl = requireOauthField(
    input.oauthTokenUrl !== undefined ? input.oauthTokenUrl : existing.oauthTokenUrl,
    'oauthTokenUrl',
  );
  const clientId = requireOauthField(
    input.oauthClientId !== undefined ? input.oauthClientId : existing.oauthClientId,
    'oauthClientId',
  );
  assertHttpUrl(authorizeUrl, 'oauthAuthorizeUrl');
  assertHttpUrl(tokenUrl, 'oauthTokenUrl');
  const revocationUrl = input.oauthRevocationUrl !== undefined ? input.oauthRevocationUrl : existing.oauthRevocationUrl;
  if (revocationUrl) assertHttpUrl(revocationUrl, 'oauthRevocationUrl');
  const scopes = input.oauthScopes !== undefined ? input.oauthScopes?.trim() || null : existing.oauthScopes;
  const clientSecretId =
    input.oauthClientSecretId !== undefined ? input.oauthClientSecretId : existing.oauthClientSecretId;
  if (clientSecretId) await assertSecret(clientSecretId);
  return {
    authKind: 'oauth',
    oauthAuthorizeUrl: authorizeUrl,
    oauthTokenUrl: tokenUrl,
    oauthRevocationUrl: revocationUrl ?? null,
    oauthScopes: scopes,
    oauthClientId: clientId,
    oauthClientSecretId: clientSecretId,
  };
}

/** session-tier read: registry + live binding counts (OAuth config is
 * non-secret and session-visible; the client SECRET shows presence only) */
export async function listRegistry() {
  const rows = await db.query.mcpServers.findMany({ orderBy: { name: 'asc' } });
  const bindings = await db.query.mcpServerBindings.findMany({ columns: { serverId: true } });
  const counts = new Map<string, number>();
  for (const b of bindings) counts.set(b.serverId, (counts.get(b.serverId) ?? 0) + 1);
  return { data: rows.map((r) => toRegistryRow(r, counts.get(r.id) ?? 0)) };
}

export async function registryCreate(input: { name: string; url: string; notes: string } & RegistryOauthInput) {
  const clash = await db.query.mcpServers.findMany({ where: { name: { eq: input.name } } });
  if (clash.length > 0) {
    throw new ORPCError('CONFLICT', { message: `MCP server "${input.name}" already exists` });
  }
  // an empty existing row: untouched input falls back to the column defaults
  const oauth = await normalizeOauthFields(
    {
      authKind: 'none',
      oauthAuthorizeUrl: null,
      oauthTokenUrl: null,
      oauthRevocationUrl: null,
      oauthScopes: null,
      oauthClientId: null,
      oauthClientSecretId: null,
    },
    input,
  );
  const inserted = await db
    .insert(mcpServers)
    .values({ name: input.name, url: input.url, notes: input.notes, ...oauth })
    .returning();
  await publishChange(CHANGE_RESOURCE.MCP, CHANGE_ACTION.CREATE);
  return toRegistryRow(nonNull(inserted[0]));
}

export async function registryUpdate(
  input: { id: string; name?: string; url?: string; notes?: string } & RegistryOauthInput,
) {
  const existing = (await db.query.mcpServers.findMany({ where: { id: { eq: input.id } } }))[0];
  if (!existing) throw new ORPCError('NOT_FOUND', { message: 'MCP registry entry not found' });
  if (input.name !== undefined && input.name !== existing.name) {
    const clash = await db.query.mcpServers.findMany({ where: { name: { eq: input.name } } });
    if (clash.length > 0) {
      throw new ORPCError('CONFLICT', { message: `MCP server "${input.name}" already exists` });
    }
  }
  // PROBE VERDICT LAW: a url change invalidates every binding verdict of this
  // server — a stale OK on a changed target would lie. Name/notes edits keep it.
  const urlChanged = input.url !== undefined && input.url !== existing.url;
  const patch: Partial<typeof mcpServers.$inferInsert> = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    updatedAt: new Date(),
  };
  // OAuth config edit = ANY authKind/oauth* key present; the wipe fires only
  // when the EFFECTIVE config changed — a no-op save (same values echoed back,
  // e.g. a notes-only edit from the UI's full-form submit) keeps tokens and
  // verdicts intact.
  const oauthPatch = await normalizeOauthFields(existing, input);
  Object.assign(patch, oauthPatch);
  const oauthChanged =
    (oauthPatch.authKind !== undefined && oauthPatch.authKind !== existing.authKind) ||
    [
      'oauthAuthorizeUrl',
      'oauthTokenUrl',
      'oauthRevocationUrl',
      'oauthScopes',
      'oauthClientId',
      'oauthClientSecretId',
    ].some(
      (k) =>
        oauthPatch[k as keyof typeof oauthPatch] !== undefined &&
        oauthPatch[k as keyof typeof oauthPatch] !== existing[k as keyof typeof existing],
    );
  // Atomic config change (SPEC): the update, the verdict clear and the token/
  // state wipe commit together — a failed save leaves the OLD config with its
  // tokens intact, never a live new config with old-contract tokens.
  let updatedRow: typeof mcpServers.$inferSelect | undefined;
  await db.transaction(async (tx) => {
    const rows = await tx.update(mcpServers).set(patch).where(eq(mcpServers.id, input.id)).returning();
    updatedRow = rows[0];
    if (urlChanged || oauthChanged) {
      await tx
        .update(mcpServerBindings)
        .set({ lastProbeOk: null, lastProbeDetail: null, lastProbeAt: null })
        .where(eq(mcpServerBindings.serverId, input.id));
    }
    if (oauthChanged) await wipeOauthTokensForServer(input.id, tx);
  });
  await publishChange(CHANGE_RESOURCE.MCP, CHANGE_ACTION.UPDATE);
  const bindings = await db.query.mcpServerBindings.findMany({
    columns: { serverId: true },
    where: { serverId: { eq: input.id } },
  });
  return toRegistryRow(nonNull(updatedRow), bindings.length);
}

export async function registryRemove(input: { id: string }) {
  // in-use guard: bindings are the permission unit — refuse while any exist
  // (cascade would silently revoke every bound agent's server)
  const linked = await db
    .select({ id: mcpServerBindings.id })
    .from(mcpServerBindings)
    .where(eq(mcpServerBindings.serverId, input.id))
    .limit(1);
  if (linked.length > 0) {
    throw new ORPCError('BAD_REQUEST', {
      message: 'registry entry is bound to at least one agent — unbind first',
    });
  }
  const deleted = await db.delete(mcpServers).where(eq(mcpServers.id, input.id)).returning({ id: mcpServers.id });
  if (deleted.length === 0) throw new ORPCError('NOT_FOUND', { message: 'MCP registry entry not found' });
  await publishChange(CHANGE_RESOURCE.MCP, CHANGE_ACTION.DELETE);
  return { ok: true };
}

/** admin read: an employee's bindings, masked credential + oauth status */
export async function bindingsList(employeeId: string) {
  const rows = await db.query.mcpServerBindings.findMany({
    where: { employeeId: { eq: employeeId } },
    with: { server: true, secret: true },
    orderBy: { id: 'asc' },
  });
  return {
    data: await Promise.all(
      (rows as BindingWithRefs[]).map(async (b) => ({
        ...toBindingRow(b),
        authKind: b.server.authKind,
        oauth: await oauthStatusFor(b.id, oauthConfigFromServerRow(b.server)),
      })),
    ),
  };
}

/** upsert by (employee, server); a credential CHANGE clears the binding's verdict */
export async function bindingsSet(input: { employeeId: string; serverId: string; secretId?: string | null }) {
  await assertAiEmployee(input.employeeId);
  await assertRegistryEntry(input.serverId);
  if (input.secretId) await assertSecret(input.secretId);
  const existing = await findBinding(input.employeeId, input.serverId);
  if (existing) {
    const credentialChanged = input.secretId !== undefined && input.secretId !== existing.secretId;
    await db
      .update(mcpServerBindings)
      .set({
        ...(input.secretId !== undefined ? { secretId: input.secretId } : {}),
        ...(credentialChanged ? { lastProbeOk: null, lastProbeDetail: null, lastProbeAt: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(mcpServerBindings.id, existing.id));
  } else {
    await db.insert(mcpServerBindings).values({
      employeeId: input.employeeId,
      serverId: input.serverId,
      ...(input.secretId !== undefined ? { secretId: input.secretId } : {}),
    });
  }
  await publishChange(CHANGE_RESOURCE.MCP, CHANGE_ACTION.UPDATE);
  const row = await findBinding(input.employeeId, input.serverId);
  if (!row) throw new ORPCError('NOT_FOUND', { message: 'binding vanished after write' });
  return toBindingRow(row);
}

/** unbind = revoke: the agent loses the server on its NEXT dispatch; an oauth
 * binding's tokens are revoked (best-effort) + deleted with it */
export async function bindingsRemove(input: { employeeId: string; serverId: string }) {
  const existing = await findBinding(input.employeeId, input.serverId);
  if (!existing) throw new ORPCError('NOT_FOUND', { message: 'binding not found' });
  if (existing.server.authKind === 'oauth') await revokeOauthTokens(existing.id);
  await db.delete(mcpServerBindings).where(eq(mcpServerBindings.id, existing.id));
  await publishChange(CHANGE_RESOURCE.MCP, CHANGE_ACTION.DELETE);
  return { ok: true };
}

/**
 * DISPATCH INJECTION: the dispatching employee's full binding list as ACP
 * `mcpServers` entries — sorted by server name (deterministic wire), the
 * Authorization header from the decrypted credential when bound. Called at
 * dispatch only; the plaintext never outlives this call.
 */
export async function buildMcpServersFor(employeeId: string): Promise<AcpMcpServer[]> {
  const rows = await db.query.mcpServerBindings.findMany({
    where: { employeeId: { eq: employeeId } },
    with: { server: true, secret: true },
  });
  const sorted = [...(rows as BindingWithRefs[])].sort((a, b) => (a.server.name < b.server.name ? -1 : 1));
  return Promise.all(
    sorted.map(async (b) => {
      // ACP v1 wire: headers is a REQUIRED array (empty = uncredentialed server)
      let headers: Array<{ name: string; value: string }> = [];
      if (b.server.authKind === 'oauth') {
        // OAuth binding: silent refresh first, then Bearer. A failed refresh
        // ships the stale token (empty headers when none) — dispatch NEVER
        // breaks on a refresh failure (SPEC: dispatch injection, OAuth).
        const token = await getFreshAccessToken(b.id, oauthConfigFromServerRow(b.server));
        if (token) headers = [{ name: 'Authorization', value: `Bearer ${token}` }];
      } else if (b.secret?.ciphertext) {
        headers = [{ name: 'Authorization', value: decryptSecret(b.secret.ciphertext) }];
      }
      return { type: 'http' as const, name: b.server.name, url: b.server.url, headers };
    }),
  );
}

/** fake-runner parity (SPEC): name the bound servers in the run output — names only, never credentials */
export function mcpDispatchLine(servers: Array<{ name: string }>): string | null {
  if (servers.length === 0) return null;
  return `[mcp] servers: ${servers
    .map((s) => s.name)
    .sort((a, b) => (a < b ? -1 : 1))
    .join(', ')}`;
}

/** JSON-RPC payload from a probe response body — plain JSON or SSE `data:` frames */
export function extractJsonRpc(text: string): { result?: unknown; error?: { code?: number; message?: string } } | null {
  const candidates: string[] = [text.trim()];
  for (const line of text.split('\n')) {
    const m = /^\s*data:\s*(.+)$/.exec(line);
    if (m?.[1]) candidates.push(m[1].trim());
  }
  for (const c of candidates) {
    if (!c.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(c) as { result?: unknown; error?: { code?: number; message?: string } };
      if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) return parsed;
    } catch {
      /* not JSON — try the next candidate */
    }
  }
  return null;
}

/** live credential test against the registry url (10s cap, both outcomes returned) */
export async function probeMcpHttp(url: string, authorization?: string): Promise<{ ok: boolean; detail: string }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (authorization) headers.authorization = authorization;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tandem-probe', version: '1' } },
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    // probe law: carry the FIRST error line — a bare "unreachable" is undiagnosable
    const message = (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? String(e);
    return { ok: false, detail: message };
  }
  if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
  const text = await res.text();
  const parsed = extractJsonRpc(text);
  if (!parsed) return { ok: false, detail: 'no JSON-RPC payload in response' };
  if (parsed.error)
    return {
      ok: false,
      detail: `MCP error ${parsed.error.code ?? ''}: ${parsed.error.message ?? 'unknown'}`.trimEnd(),
    };
  const info = (parsed.result as { serverInfo?: { name?: string; version?: string } } | undefined)?.serverInfo;
  return { ok: true, detail: `initialize ok (${info?.name ?? 'server'}${info?.version ? ` v${info.version}` : ''})` };
}

/** PROBE VERDICT LAW on the binding row: persist BOTH outcomes */
export async function persistBindingVerdict(bindingId: string, r: { ok: boolean; detail: string }) {
  await db
    .update(mcpServerBindings)
    .set({ lastProbeOk: r.ok, lastProbeDetail: r.detail, lastProbeAt: new Date(), updatedAt: new Date() })
    .where(eq(mcpServerBindings.id, bindingId));
}

export async function probeMcpBinding(input: { employeeId: string; serverId: string }) {
  const binding = await findBinding(input.employeeId, input.serverId);
  if (!binding) throw new ORPCError('NOT_FOUND', { message: 'binding not found' });
  // decrypt server-side at probe only — same law as dispatch. OAuth bindings
  // ride the same silent-refresh path dispatch uses, then Bearer.
  let authorization: string | undefined;
  if (binding.server.authKind === 'oauth') {
    const token = await getFreshAccessToken(binding.id, oauthConfigFromServerRow(binding.server));
    if (token) authorization = `Bearer ${token}`;
  } else if (binding.secret?.ciphertext) {
    authorization = decryptSecret(binding.secret.ciphertext);
  }
  const started = Date.now();
  const result = await probeMcpHttp(binding.server.url, authorization);
  const durationMs = Date.now() - started;
  await persistBindingVerdict(binding.id, result);
  await publishChange(CHANGE_RESOURCE.MCP, CHANGE_ACTION.UPDATE);
  return { ...result, durationMs, lastProbeAt: new Date().toISOString() };
}
