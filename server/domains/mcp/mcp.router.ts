// MCP router — business logic lives in mcp.service.ts; this file only wires
// procedures (SPEC "MCP (registry + per-agent bindings)"): registry is
// admin-written with a session-tier read; bindings + probe are admin (they
// touch credentials).
import { os } from '@orpc/server';
import { z } from 'zod';

import { adminProcedure, ORPCError, protectedProcedure } from '../kernel/kernel';
import { oauthConnectOrigin, startOauthConnect } from './mcp-oauth.service';
import {
  bindingsList,
  bindingsRemove,
  bindingsSet,
  listRegistry,
  probeMcpBinding,
  registryCreate,
  registryRemove,
  registryUpdate,
} from './mcp.service';

const nameField = z.string().trim().min(1).max(200);
const urlField = z
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
const notesField = z.string().trim().max(2000).default('');
const idField = z.string().min(1);

// slice 2 OAuth registry fields — validation of the REQUIRED-for-oauth shape
// lives in the service (normalizeOauthFields: authorize/token urls + clientId)
const oauthInputShape = {
  authKind: z.enum(['none', 'oauth']).optional(),
  oauthAuthorizeUrl: urlField.nullish(),
  oauthTokenUrl: urlField.nullish(),
  oauthRevocationUrl: urlField.nullish(),
  oauthScopes: z.string().trim().max(500).nullish(),
  oauthClientId: z.string().trim().min(1).max(500).nullish(),
  oauthClientSecretId: idField.nullish(),
};

export const mcpRouter = os.router({
  registryList: protectedProcedure.handler(() => listRegistry()),

  registryCreate: adminProcedure
    .input(z.strictObject({ name: nameField, url: urlField, notes: notesField, ...oauthInputShape }))
    .handler(({ input }) => registryCreate(input)),

  registryUpdate: adminProcedure
    .input(
      z.strictObject({
        id: idField,
        name: nameField.optional(),
        url: urlField.optional(),
        notes: notesField.optional(),
        ...oauthInputShape,
      }),
    )
    .handler(({ input }) => registryUpdate(input)),

  registryRemove: adminProcedure.input(z.strictObject({ id: idField })).handler(({ input }) => registryRemove(input)),

  bindingsList: adminProcedure
    .input(z.strictObject({ employeeId: idField }))
    .handler(({ input }) => bindingsList(input.employeeId)),

  bindingsSet: adminProcedure
    .input(
      z.strictObject({
        employeeId: idField,
        serverId: idField,
        secretId: z.union([idField, z.null()]).optional(),
      }),
    )
    .handler(({ input }) =>
      bindingsSet({
        employeeId: input.employeeId,
        serverId: input.serverId,
        ...(input.secretId !== undefined ? { secretId: input.secretId } : {}),
      }),
    ),

  bindingsRemove: adminProcedure
    .input(z.strictObject({ employeeId: idField, serverId: idField }))
    .handler(({ input }) => bindingsRemove(input)),

  probe: adminProcedure
    .input(z.strictObject({ employeeId: idField, serverId: idField }))
    .handler(({ input }) => probeMcpBinding(input)),

  // #278: the connect mint rides an admin POST — the legacy state-changing
  // GET /api/mcp/oauth/connect rode a SameSite=Lax admin session on any
  // forged top-level navigation (CSRF-intent binding). Lax drops cookies on
  // cross-site POSTs, so a forged link has no same-site mint to hit.
  oauthConnect: adminProcedure
    .input(z.strictObject({ employeeId: idField, serverId: idField }))
    .handler(async ({ input, context }) => {
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
