// MCP router — business logic lives in mcp.service.ts; this file only wires
// procedures (SPEC "MCP (registry + per-agent bindings)"): registry is
// admin-written with a session-tier read; bindings + probe are admin (they
// touch credentials).
import { os } from '@orpc/server';
import { z } from 'zod';

import { isUuid } from '#shared/utils/is-uuid';
import { storable, storableId, storableIdRef } from '#shared/utils/storable-text';

import { requireUuid } from '../kernel/id-shape';
import { adminProcedure, ORPCError, protectedProcedure } from '../kernel/kernel';
import { oauthConnectOrigin, startOauthConnect } from './mcp-oauth.service';
import {
  bindingsList,
  bindingsListByServer,
  bindingsRemove,
  bindingsSet,
  listRegistry,
  probeMcpBinding,
  registryCreate,
  registryRemove,
  registryUpdate,
} from './mcp.service';

const nameField = storable('name', z.string().trim().min(1).max(200));
// url/command are transport-conditional (http needs url; stdio needs an
// absolute command) — the required-field validation lives in the service
// the shape check proves http(s) only — new URL() percent-encodes a NUL in the
// PATH and returns the RAW input, so the storability refusal rides the field
const urlShape = z
  .string()
  .trim()
  .min(1)
  .refine((u) => {
    try {
      return new URL(u).protocol === 'http:' || new URL(u).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'url must be an http/https URL');
const urlField = (field: string) => storable(field, urlShape);
const commandField = storable('command', z.string().trim().min(1));
const argsField = z.array(z.string());
const credentialEnvVarField = z
  .string()
  .trim()
  .refine((v) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v), 'credentialEnvVar must be a valid env var name');
const notesField = storable('notes', z.string().trim().max(2000).default(''));
const idField = (field: string) => (field === 'id' ? storableId('id') : storableIdRef(field));
const transportField = z.enum(['http', 'stdio']);

// slice 3 stdio transport fields (transport-conditional validation of the
// required shape lives in the service: normalizeTransportFields)
const transportInputShape = {
  transport: transportField.optional(),
  url: urlField('url').nullish(),
  command: commandField.nullish(),
  args: argsField.nullish(),
  credentialEnvVar: credentialEnvVarField.nullish(),
};

// slice 2 OAuth registry fields — validation of the REQUIRED-for-oauth shape
// lives in the service (normalizeOauthFields: authorize/token urls + clientId)
const oauthInputShape = {
  authKind: z.enum(['none', 'oauth']).optional(),
  oauthAuthorizeUrl: urlField('oauthAuthorizeUrl').nullish(),
  oauthTokenUrl: urlField('oauthTokenUrl').nullish(),
  oauthRevocationUrl: urlField('oauthRevocationUrl').nullish(),
  oauthScopes: storable('oauthScopes', z.string().trim().max(500).nullish()),
  oauthClientId: storable('oauthClientId', z.string().trim().min(1).max(500).nullish()),
  oauthClientSecretId: idField('oauthClientSecretId').nullish(),
};

export const mcpRouter = os.router({
  registryList: protectedProcedure.handler(() => listRegistry()),

  registryCreate: adminProcedure
    .input(z.strictObject({ name: nameField, notes: notesField, ...transportInputShape, ...oauthInputShape }))
    .handler(({ input }) => registryCreate(input)),

  registryUpdate: adminProcedure
    .input(
      z.strictObject({
        id: idField('id'),
        name: nameField.optional(),
        notes: notesField.optional(),
        ...transportInputShape,
        ...oauthInputShape,
      }),
    )
    .handler(({ input }) => registryUpdate(input)),

  registryRemove: adminProcedure
    .input(z.strictObject({ id: idField('id') }))
    .handler(({ input }) => registryRemove(input)),

  bindingsList: adminProcedure.input(z.strictObject({ employeeId: z.string() })).handler(({ input }) =>
    // a filter is not a lookup: blank / non-uuid values are the empty page
    // (UUID-FILTER LAW), never a schema error, never a uuid-column query
    isUuid(input.employeeId) ? bindingsList(input.employeeId) : { data: [] },
  ),

  // per-server read for the registry page's binding manager (#274)
  bindingsListByServer: adminProcedure
    .input(z.strictObject({ serverId: idField('serverId') }))
    .handler(({ input }) => bindingsListByServer(input.serverId)),

  bindingsSet: adminProcedure
    .input(
      z.strictObject({
        employeeId: idField('employeeId'),
        serverId: idField('serverId'),
        secretId: z.union([idField('secretId'), z.null()]).optional(),
      }),
    )
    .handler(async ({ input }) => {
      requireUuid(input.employeeId, 'BAD_REQUEST', 'invalid employee id');
      return bindingsSet({
        employeeId: input.employeeId,
        serverId: input.serverId,
        ...(input.secretId !== undefined ? { secretId: input.secretId } : {}),
      });
    }),

  bindingsRemove: adminProcedure
    .input(z.strictObject({ employeeId: idField('employeeId'), serverId: idField('serverId') }))
    .handler(({ input }) => {
      requireUuid(input.employeeId, 'BAD_REQUEST', 'invalid employee id');
      return bindingsRemove(input);
    }),

  probe: adminProcedure
    .input(z.strictObject({ employeeId: z.string(), serverId: idField('serverId') }))
    .handler(({ input }) => {
      // probe is a read of one binding: blank / malformed employee ids are the same
      // miss a well-formed id with no binding behind it answers (blank is accepted at
      // the schema edge and owned by this miss path)
      requireUuid(input.employeeId, 'NOT_FOUND', 'binding not found');
      return probeMcpBinding(input);
    }),

  // #278: the connect mint rides an admin POST — the legacy state-changing
  // GET /api/mcp/oauth/connect rode a SameSite=Lax admin session on any
  // forged top-level navigation (CSRF-intent binding). Lax drops cookies on
  // cross-site POSTs, so a forged link has no same-site mint to hit.
  oauthConnect: adminProcedure
    .input(z.strictObject({ employeeId: idField('employeeId'), serverId: idField('serverId') }))
    .handler(async ({ input, context }) => {
      requireUuid(input.employeeId, 'BAD_REQUEST', 'invalid employee id');
      try {
        const minted = await startOauthConnect({
          employeeId: input.employeeId,
          serverId: input.serverId,
          origin: oauthConnectOrigin(context.reqHeaders),
        });
        return { connectUrl: minted.authorizeUrl, serverName: minted.serverName };
      } catch (e) {
        // the service throws plain Errors (they land on the callback result
        // page in the flow) — surface them as RPC 400s for the editor
        throw new ORPCError('BAD_REQUEST', { message: e instanceof Error ? e.message : 'connect failed' });
      }
    }),
});
