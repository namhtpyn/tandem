import { consola } from 'consola';
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
    transport: r.transport,
    url: r.url,
    command: r.command,
    args: safeArgsJson(`server:${r.id}`, r.args),
    credentialEnvVar: r.credentialEnvVar,
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
  server: { name: string; transport: string; url: string | null };
  secret: { name: string; lastFour: string } | null;
}) {
  return {
    id: b.id,
    serverId: b.serverId,
    serverName: b.server.name,
    transport: b.server.transport,
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
    id: string;
    name: string;
    transport: string;
    url: string | null;
    command: string | null;
    args: string | null;
    credentialEnvVar: string | null;
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

// slice 3 stdio transport — shared types + validation (SPEC "stdio transport")
export type RegistryTransportInput = {
  transport?: 'http' | 'stdio';
  url?: string | null;
  command?: string | null;
  args?: string[] | null;
  credentialEnvVar?: string | null;
};

/** parse the serialized args column — null/empty → []; invalid JSON or a
 * non-string-array → 400 (a corrupt column is dead input, never dispatched) */
export function parseArgsJson(args: string | null | undefined): string[] {
  if (!args) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    throw new ORPCError('BAD_REQUEST', { message: 'args must be a JSON array of strings' });
  }
  if (!Array.isArray(parsed) || parsed.some((a) => typeof a !== 'string')) {
    throw new ORPCError('BAD_REQUEST', { message: 'args must be a JSON array of strings' });
  }
  return parsed;
}

const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** args entries must survive the one-per-line editor round-trip: non-empty,
 * single-line, no leading/trailing whitespace (anything else would be silently
 * rewritten by the registry form — dead input, refused 400) */
const validatedArgs = (args: string[]) => {
  for (const a of args) {
    // CR counts as a line terminator too (browsers normalize CR→LF; a lone CR
    // would render as two lines in the editor and silently split on the next save)
    if (a === '' || /[\r\n]/.test(a) || a.trim() !== a) {
      throw new ORPCError('BAD_REQUEST', {
        message: 'args entries must be non-empty single-line strings without padding whitespace',
      });
    }
  }
  return args;
};

/** any oauth ENDPOINT key present — authKind 'none' is NOT oauth config (it's
 * the explicit static-credential choice a full-form save always echoes) */
const oauthEndpointKeysTouched = (input: RegistryOauthInput) =>
  input.oauthAuthorizeUrl !== undefined ||
  input.oauthTokenUrl !== undefined ||
  input.oauthRevocationUrl !== undefined ||
  input.oauthScopes !== undefined ||
  input.oauthClientId !== undefined ||
  input.oauthClientSecretId !== undefined;

/** corrupt args columns are unreachable via any product write path, but a read
 * surface must never let one dead row take down the whole list/plan: degrade to
 * the spec-shape empty array, log ONCE per row */
const warnedCorruptArgs = new Set<string>();
const safeArgsJson = (key: string, args: string | null | undefined): string[] => {
  try {
    return parseArgsJson(args);
  } catch (e) {
    if (!warnedCorruptArgs.has(key)) {
      warnedCorruptArgs.add(key);
      consola.error(`[mcp] corrupt args column on ${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return [];
  }
};

/** stdio branch of the transport validation: oauth refusal + command (absolute)
 * + args + credential env var name. Returns the stdio columns to write. */
function normalizeStdioFields(
  existing: Pick<
    typeof mcpServers.$inferSelect,
    'transport' | 'url' | 'command' | 'args' | 'credentialEnvVar' | 'authKind'
  > | null,
  input: RegistryTransportInput & RegistryOauthInput,
): Partial<typeof mcpServers.$inferInsert> {
  const patch: Partial<typeof mcpServers.$inferInsert> = {};
  // OAuth authorization is an http contract (endpoints + Bearer headers have no
  // stdio meaning) — an oauth entry / stray oauth ENDPOINT keys on a stdio
  // write are refused, never silently stripped. The switch refusal keys off the
  // PERSISTED row's authKind (a full-form save always echoes authKind 'none' —
  // keying off the echo would let a transport switch silently strip a live
  // OAuth config and wipe its tokens).
  if (existing?.authKind === 'oauth' || input.authKind === 'oauth' || oauthEndpointKeysTouched(input)) {
    throw new ORPCError('BAD_REQUEST', {
      message: 'oauth config belongs to http servers — stdio entries cannot carry it',
    });
  }
  const command = input.command !== undefined && input.command !== null ? input.command : (existing?.command ?? null);
  if (!command) throw new ORPCError('BAD_REQUEST', { message: 'command is required for stdio servers' });
  if (!command.startsWith('/')) {
    throw new ORPCError('BAD_REQUEST', { message: 'command must be an absolute path (ACP stdio contract)' });
  }
  patch.command = command;
  patch.args = input.args !== undefined ? JSON.stringify(validatedArgs(input.args ?? [])) : (existing?.args ?? '[]');
  if (input.credentialEnvVar !== undefined) {
    const v = input.credentialEnvVar;
    if (v && !ENV_VAR_RE.test(v)) {
      throw new ORPCError('BAD_REQUEST', { message: 'credentialEnvVar must be a valid env var name' });
    }
    patch.credentialEnvVar = v || null;
  }
  // a stdio entry carries no http target — the url column stays null (nullable
  // for exactly this)
  patch.url = null;
  return patch;
}

/** http branch of the transport validation: url required + stdio-only field
 * refusal + the OTHER side's columns nulled (a transport switch leaves the row
 * carrying exactly its transport's field set — mirroring patch.url = null). */
function normalizeHttpFields(
  existing: Pick<typeof mcpServers.$inferSelect, 'url'> | null,
  input: RegistryTransportInput,
): Partial<typeof mcpServers.$inferInsert> {
  const patch: Partial<typeof mcpServers.$inferInsert> = {};
  const url = input.url !== undefined && input.url !== null ? input.url : (existing?.url ?? null);
  if (!url) throw new ORPCError('BAD_REQUEST', { message: 'url is required for http servers' });
  assertHttpUrl(url, 'url');
  patch.url = url;
  patch.command = null;
  patch.args = null;
  patch.credentialEnvVar = null;
  for (const stdioOnly of ['command', 'args', 'credentialEnvVar'] as const) {
    const v = input[stdioOnly];
    if (v !== undefined && v !== null) {
      throw new ORPCError('BAD_REQUEST', {
        message: `${stdioOnly} belongs to stdio servers (transport http)`,
      });
    }
  }
  return patch;
}

/** transport-conditional validation (SPEC stdio section): resolve the
 * EFFECTIVE transport from input+existing, enforce http↔stdio field
 * requirements, refuse oauth ∩ stdio. Returns the transport-conditional
 * columns to write; name/notes/oauth columns stay the caller's. */
function normalizeTransportFields(
  existing: Pick<
    typeof mcpServers.$inferSelect,
    'transport' | 'url' | 'command' | 'args' | 'credentialEnvVar' | 'authKind'
  > | null,
  input: RegistryTransportInput & RegistryOauthInput,
): Partial<typeof mcpServers.$inferInsert> {
  const transport =
    input.transport !== undefined && input.transport !== null ? input.transport : (existing?.transport ?? 'http');
  if (transport !== 'http' && transport !== 'stdio') {
    throw new ORPCError('BAD_REQUEST', { message: 'transport must be http or stdio' });
  }
  const patch = transport === 'stdio' ? normalizeStdioFields(existing, input) : normalizeHttpFields(existing, input);
  // the transport column itself rides every create/update (a create WITHOUT it
  // would land on the 'http' column default — never the caller's intent)
  patch.transport = transport;
  return patch;
}

/** whether the stdio target contract changed (SPEC verdict-invalidation law:
 * a transport switch or command/args/credentialEnvVar change clears verdicts) */
function stdioTargetChanged(
  existing: typeof mcpServers.$inferSelect,
  patch: Partial<typeof mcpServers.$inferInsert>,
): boolean {
  return (
    (patch.command !== undefined && patch.command !== existing.command) ||
    (patch.args !== undefined && patch.args !== existing.args) ||
    (patch.credentialEnvVar !== undefined && patch.credentialEnvVar !== existing.credentialEnvVar)
  );
}

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

export async function registryCreate(
  input: { name: string; notes: string } & RegistryTransportInput & RegistryOauthInput,
) {
  const clash = await db.query.mcpServers.findMany({ where: { name: { eq: input.name } } });
  if (clash.length > 0) {
    throw new ORPCError('CONFLICT', { message: `MCP server "${input.name}" already exists` });
  }
  // transport-conditional fields first (an oauth ∩ stdio refusal fires here,
  // before any oauth normalization runs)
  const transport = normalizeTransportFields(null, input);
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
    .values({ name: input.name, notes: input.notes, ...transport, ...oauth })
    .returning();
  await publishChange(CHANGE_RESOURCE.MCP, CHANGE_ACTION.CREATE);
  return toRegistryRow(nonNull(inserted[0]));
}

export async function registryUpdate(
  input: { id: string; name?: string; notes?: string } & RegistryTransportInput & RegistryOauthInput,
) {
  const existing = (await db.query.mcpServers.findMany({ where: { id: { eq: input.id } } }))[0];
  if (!existing) throw new ORPCError('NOT_FOUND', { message: 'MCP registry entry not found' });
  if (input.name !== undefined && input.name !== existing.name) {
    const clash = await db.query.mcpServers.findMany({ where: { name: { eq: input.name } } });
    if (clash.length > 0) {
      throw new ORPCError('CONFLICT', { message: `MCP server "${input.name}" already exists` });
    }
  }
  // transport-conditional fields first (oauth ∩ stdio refusal fires before any
  // oauth normalization runs)
  const transportPatch = normalizeTransportFields(existing, input);
  // PROBE VERDICT LAW: a target change (url for http; transport switch or
  // command/args/credentialEnvVar for stdio) invalidates every binding verdict
  // of this server — a stale OK on a changed target would lie. Name/notes
  // edits keep it.
  const urlChanged = transportPatch.url !== undefined && transportPatch.url !== existing.url;
  const stdioChanged = stdioTargetChanged(existing, transportPatch);
  const patch: Partial<typeof mcpServers.$inferInsert> = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...transportPatch,
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
    if (urlChanged || stdioChanged || oauthChanged) {
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

type ServerBindingWithRefs = BindingWithRefs & {
  employee: { id: string; name: string };
};

/** admin read: one registry entry's bindings across agents — the per-server
 * surface behind the registry page's binding manager (#274, SPEC "Binding
 * surfaces"): same masked shape as bindingsList keyed by agent, never the
 * credential plaintext */
export async function bindingsListByServer(serverId: string) {
  const rows = await db.query.mcpServerBindings.findMany({
    where: { serverId: { eq: serverId } },
    with: { employee: true, server: true, secret: true },
    orderBy: { id: 'asc' },
  });
  return {
    data: await Promise.all(
      (rows as ServerBindingWithRefs[]).map(async (b) => ({
        ...toBindingRow(b),
        employeeId: b.employee.id,
        employeeName: b.employee.name,
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
      if (b.server.transport === 'stdio') {
        // slice 3 stdio member: the binding credential rides as the env var
        // NAMED by credentialEnvVar (decrypted at dispatch only, plaintext
        // never outlives this call) — env carries ONLY that var
        const env: Array<{ name: string; value: string }> = [];
        if (b.server.credentialEnvVar && b.secret?.ciphertext) {
          env.push({ name: b.server.credentialEnvVar, value: decryptSecret(b.secret.ciphertext) });
        }
        return {
          type: 'stdio' as const,
          name: b.server.name,
          command: nonNull(b.server.command),
          // one corrupt row must not fail the employee's WHOLE dispatch plan —
          // skip + log-once (read-surface degradation, SPEC empty-args shape)
          args: safeArgsJson(`server:${b.server.id}`, b.server.args),
          env,
        };
      }
      // ACP v1 wire: headers is a REQUIRED array (empty = uncredentialed server);
      // url is validation-required for http entries
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
      return { type: 'http' as const, name: b.server.name, url: nonNull(b.server.url), headers };
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
    // a plain stdout banner line before the response must not blind the probe —
    // every line is a candidate (whole-buffer first)
    candidates.push(line.trim());
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

/** read stdout until a JSON-RPC response lands or the cap expires — servers
 * may banner to stdout first, so parse line-wise (extractJsonRpc) */
async function readInitializeResponse(
  stdout: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<ReturnType<typeof extractJsonRpc>> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // ONE deadline for the whole handshake — a chatty server that never answers
  // must hit the cap, not re-arm it per chunk
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for the initialize response`)),
      timeoutMs,
    );
  });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) return null;
      // streaming decode: a multibyte char split across chunk boundaries must
      // not bake U+FFFD into the buffer
      buf += decoder.decode(chunk.value, { stream: true });
      const parsed = extractJsonRpc(buf);
      if (parsed) return parsed;
    }
  } finally {
    clearTimeout(timer);
  }
}

/** map a probe exchange to its verdict — failure detail carries the FIRST
 * error line (stderr beats the bare exit code), never a bare "spawn failed" */
async function verdictFromResponse(
  parsed: ReturnType<typeof extractJsonRpc>,
  exitCode: number | null,
  stderr: ReadableStream<Uint8Array>,
): Promise<{ ok: boolean; detail: string }> {
  if (!parsed) {
    if (typeof exitCode === 'number' && exitCode !== 0) {
      // probe law: carry the FIRST error line (stderr beats the bare exit code);
      // the drain is CAPPED — a descendant holding the pipe must not hang the probe
      const errText = await Promise.race([
        new Response(stderr).text().catch(() => ''),
        new Promise<string>((resolve) => {
          setTimeout(() => resolve(''), 1_000);
        }),
      ]);
      const firstErr = errText.split('\n').find((l) => l.trim());
      return { ok: false, detail: (firstErr ?? `server exited with code ${exitCode}`).trim().slice(0, 300) };
    }
    if (typeof exitCode === 'number') return { ok: false, detail: 'server exited before responding' };
    return { ok: false, detail: 'no JSON-RPC payload in server output' };
  }
  if (parsed.error)
    return {
      ok: false,
      detail: `MCP error ${parsed.error.code ?? ''}: ${parsed.error.message ?? 'unknown'}`.trimEnd(),
    };
  const info = (parsed.result as { serverInfo?: { name?: string; version?: string } } | undefined)?.serverInfo;
  return { ok: true, detail: `initialize ok (${info?.name ?? 'server'}${info?.version ? ` v${info.version}` : ''})` };
}

/** slice 3 stdio probe (SPEC "Probe (stdio)"): spawn `command args` (+ the
 * credential env var — the child inherits nothing else), MCP `initialize`
 * handshake over stdin, JSON-RPC response on stdout within the 10s cap, then
 * the child is KILLED — a probe never leaves a spawned process running.
 * Failure detail carries the first error line — never a bare "spawn failed". */
export async function probeMcpStdio(
  command: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 10_000,
): Promise<{ ok: boolean; detail: string }> {
  let child: ReturnType<typeof Bun.spawn> | null = null;
  try {
    child = Bun.spawn([command, ...args], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    // the spawn options pin 'pipe' — narrow past Bun's `number | stream` union
    const stdin = child.stdin as Bun.FileSink;
    const stdout = child.stdout as ReadableStream<Uint8Array>;
    const stderr = child.stderr as ReadableStream<Uint8Array>;
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'tandem-probe', version: '1' },
        },
      })}\n`,
    );
    await stdin.flush();
    const parsed = await readInitializeResponse(stdout, timeoutMs);
    const exitCode = await Promise.race([
      child.exited,
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 1_000);
      }),
    ]);
    return verdictFromResponse(parsed, exitCode, stderr);
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? String(e);
    return { ok: false, detail: message };
  } finally {
    if (child) {
      try {
        child.kill();
        const gone = await Promise.race([
          child.exited,
          new Promise<null>((resolve) => {
            setTimeout(() => resolve(null), 1_000);
          }),
        ]);
        if (gone === null) {
          // SIGTERM alone is not a kill guarantee (a wrapper can trap it) —
          // escalate so the kill law actually holds
          child.kill('SIGKILL');
          await child.exited;
        }
      } catch {
        /* already dead */
      }
    }
  }
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
  const started = Date.now();
  let result: { ok: boolean; detail: string };
  if (binding.server.transport === 'stdio') {
    // stdio bindings decrypt the credential ONLY as the named env var (no
    // Authorization header is ever built for them)
    let env: Record<string, string> = {};
    let args: string[] = [];
    try {
      args = parseArgsJson(binding.server.args);
      if (binding.server.credentialEnvVar && binding.secret?.ciphertext) {
        env = { [binding.server.credentialEnvVar]: decryptSecret(binding.secret.ciphertext) };
      }
    } catch (e) {
      // a corrupt args column is dead input — the PROBE VERDICT LAW still gets
      // its failure verdict instead of the throw escaping verdict persistence
      result = {
        ok: false,
        detail: `corrupt args column: ${e instanceof Error ? e.message : String(e)}`,
      };
      const durationMs = Date.now() - started;
      await persistBindingVerdict(binding.id, result);
      await publishChange(CHANGE_RESOURCE.MCP, CHANGE_ACTION.UPDATE);
      return { ...result, durationMs, lastProbeAt: new Date().toISOString() };
    }
    result = await probeMcpStdio(nonNull(binding.server.command), args, env);
  } else {
    // http: url is validation-required; the binding credential rides the
    // Authorization header (decrypt at probe only)
    let authorization: string | undefined;
    if (binding.server.authKind === 'oauth') {
      const token = await getFreshAccessToken(binding.id, oauthConfigFromServerRow(binding.server));
      if (token) authorization = `Bearer ${token}`;
    } else if (binding.secret?.ciphertext) {
      authorization = decryptSecret(binding.secret.ciphertext);
    }
    result = await probeMcpHttp(nonNull(binding.server.url), authorization);
  }
  const durationMs = Date.now() - started;
  await persistBindingVerdict(binding.id, result);
  await publishChange(CHANGE_RESOURCE.MCP, CHANGE_ACTION.UPDATE);
  return { ...result, durationMs, lastProbeAt: new Date().toISOString() };
}
