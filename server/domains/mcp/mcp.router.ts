// MCP router — business logic lives in mcp.service.ts; this file only wires
// procedures (SPEC "MCP (registry + per-agent bindings)"): registry is
// admin-written with a session-tier read; bindings + probe are admin (they
// touch credentials).
import { os } from '@orpc/server';
import { z } from 'zod';

import { adminProcedure, protectedProcedure } from '../kernel/kernel';
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

export const mcpRouter = os.router({
  registryList: protectedProcedure.handler(() => listRegistry()),

  registryCreate: adminProcedure
    .input(z.strictObject({ name: nameField, url: urlField, notes: notesField }))
    .handler(({ input }) => registryCreate(input)),

  registryUpdate: adminProcedure
    .input(
      z.strictObject({
        id: idField,
        name: nameField.optional(),
        url: urlField.optional(),
        notes: notesField.optional(),
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
});
