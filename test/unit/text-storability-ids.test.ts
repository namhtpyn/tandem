// TEXT-STORABILITY LAW (#386, SPEC "API law"): every TEXT-TYPED ID parameter —
// read key, write target, store key or list filter — refuses NUL and unpaired
// surrogates at the procedure edge with the field-named BAD_REQUEST, before the
// value can reach a query parameter (a NUL raises at the driver; a lone
// surrogate is rewritten to U+FFFD and the read misses on a corrupted value,
// while the two upsert-by-id writes would create a NEW row under the corrupted
// id). Handler-level pins below call the REAL oRPC procedures; input validation
// fires before any db access, so a refusal never needs a database. The accept /
// blank / clear / null / cap axes ride the same wired input schema.
import { createProcedureClient } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ROLE } from '#shared/enums';

// humanProcedure resolves the credential origin through the db — these pins are
// about schema edges, and a unit test must not depend on a live database
vi.mock('../../server/domains/kernel/session-origin', () => ({ isApiKeySession: async () => false }));

import { appRouter } from '../../server/domains/app.router';
import { channelsRouter } from '../../server/domains/channels/channels.router';
import { adminChannelConfigSchema, channelConfigSchema } from '../../server/domains/channels/channels.service';
import { employeesRouter } from '../../server/domains/employees/employees.router';
import { environmentsRouter } from '../../server/domains/environments/environments.router';
import { mcpRouter } from '../../server/domains/mcp/mcp.router';
import { oidcRouter } from '../../server/domains/oidc/oidc.router';
import { projectsRouter } from '../../server/domains/projects/projects.router';
import { providersRouter } from '../../server/domains/providers/providers.router';
import { settingsRouter } from '../../server/domains/settings/settings.router';
import { statusesRouter } from '../../server/domains/statuses/statuses.router';
import { tasksRouter } from '../../server/domains/tasks/tasks.router';
import { vaultRouter } from '../../server/domains/vault/vault.router';

const NUL = 'A\u0000B';
const LONE_HIGH = 'A\uD800B';
const LONE_LOW = 'A\uDC00B';
const ASTRAL = 'A😀B';
/** a canonical uuid for the binding rows channel configs require */
const USER_UUID = '0190f3f1-0000-7000-8000-000000000001';

const adminSession = {
  sessionId: 'unit-session-row',
  user: { id: 'u1', name: 'Unit', email: 'unit@tandem.local', role: ROLE.ADMIN },
} as const;

function client(procedure: unknown) {
  return createProcedureClient(
    procedure as never,
    {
      context: {
        reqHeaders: undefined,
        getSession: async () => adminSession,
      },
    } as never,
  ) as (input: unknown) => Promise<unknown>;
}

type InputSchema = {
  safeParse: (value: unknown) => { success: boolean };
};

/** the input schema the procedure is actually wired with */
function schemaOf(procedure: unknown): InputSchema {
  const orpc = (procedure as Record<string, unknown>)['~orpc'] as { inputSchemas: InputSchema[] };
  if (orpc.inputSchemas.length !== 1) throw new Error(`expected one input schema, got ${orpc.inputSchemas.length}`);
  return orpc.inputSchemas[0] as InputSchema;
}

type Path = (string | number)[];

type Surface = {
  /** procedure label used in the assertion output */
  surface: string;
  procedure: unknown;
  run: (input: unknown) => Promise<unknown>;
  /** a minimal input that passes every OTHER rule (validation only — the handler never runs on refusal) */
  base: Record<string, unknown>;
  /** the text field under test (used for the message and as the default path) */
  field: string;
  /** where the id sits when it is not a top-level field */
  leaf?: Path;
  /** a pre-existing cap on the id value, when the field has one */
  cap?: number;
  /** true when the field is optional and its omitted path must stay open */
  clearable?: boolean;
  /** true when the field also accepts an explicit null */
  nullable?: boolean;
  /** true when this is a READ key (a padded value is an ordinary miss) */
  ref?: boolean;
  /** the value an OMITTED field parses to when the schema carries a default */
  omittedDefault?: unknown;
  /** build the field value from the payload variant (defaults to the string itself) */
  valueFor?: (value: string) => unknown;
  /** the input key carrying the value when it differs from the field label */
  inputKey?: string;
  /** UUID-FILTER LAW surfaces deliberately accept a blank id (blank = empty page / miss) */
  blankAllowed?: boolean;
};

const s = (
  surface: string,
  procedure: unknown,
  base: Record<string, unknown>,
  field: string,
  extra: Partial<Surface> = {},
): Surface => ({
  surface,
  procedure,
  run: client(procedure),
  base,
  field,
  ...extra,
});

/** set a leaf, creating plain-object parents along the way */
function setAt<T>(base: T, path: Path, value: unknown): T {
  const out = structuredClone(base) as unknown as Record<string | number, unknown>;
  let node = out;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    node[key] = next === undefined ? {} : next;
    node = node[key] as Record<string | number, unknown>;
  }
  node[path[path.length - 1] as string | number] = value;
  return out as unknown as T;
}

function deleteAt<T>(base: T, path: Path): T {
  const out = structuredClone(base) as unknown as Record<string | number, unknown>;
  let node = out;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  delete node[path[path.length - 1] as string | number];
  return out as unknown as T;
}

/** read the value at a leaf path (array indices included) from parsed data */
function getAt<T>(value: T, path: Path): unknown {
  let node: unknown = value;
  for (const key of path) {
    if (node === null || node === undefined) return undefined;
    node = (node as Record<string | number, unknown>)[key as string | number];
  }
  return node;
}

const providerBase = () => ({ label: 'L', baseUrl: 'https://provider.test', endpoints: ['OPENAI-COMPLETIONS'] });
const envBase = () => ({ name: 'n', host: 'host.test', port: '22', username: 'u' });
const assignment = (field: 'providerId' | 'model' | 'keySecretId', value: string) => ({
  providerId: field === 'providerId' ? value : 'p',
  model: field === 'model' ? value : 'm',
  keySecretId: field === 'keySecretId' ? value : 'k',
});
const channelEntry = (tokenSecretId = 'secret-id') => ({
  kind: 'matrix',
  enabled: false,
  homeserverUrl: 'https://matrix.example.org',
  tokenSecretId,
  bindings: [],
  defaultAssigneeId: null,
});

const employeeCreateBase = () => ({ name: 'N', email: 'n@example.test', kind: 'ai', title: 'T' });
const employeeUpdateBase = () => ({ id: 'x', name: 'N', title: 'T', supervisorIds: [] });

const surfaces: Surface[] = [
  // ---- tasks: reads, writes, thread verbs, filters, cursors ----
  s('tasks.get:taskId', tasksRouter.get, { taskId: 'x' }, 'taskId'),
  s('tasks.update:id', tasksRouter.update, { id: 'x' }, 'id'),
  s('tasks.update:projectId', tasksRouter.update, { id: 'x' }, 'projectId', { clearable: true, nullable: true }),
  s('tasks.update:assigneeId', tasksRouter.update, { id: 'x' }, 'assigneeId', { clearable: true, nullable: true }),
  s('tasks.update:ownerId', tasksRouter.update, { id: 'x' }, 'ownerId', { clearable: true, nullable: true }),
  s('tasks.update:reviewers', tasksRouter.update, { id: 'x' }, 'reviewers', {
    clearable: true,
    nullable: true,
    valueFor: (v) => [v],
  }),
  s('tasks.create:projectId', tasksRouter.create, { title: 'T' }, 'projectId', { clearable: true, nullable: true }),
  s('tasks.create:assigneeId', tasksRouter.create, { title: 'T' }, 'assigneeId', { clearable: true, nullable: true }),
  s('tasks.create:ownerId', tasksRouter.create, { title: 'T' }, 'ownerId', { clearable: true, nullable: true }),
  s('tasks.create:reviewers', tasksRouter.create, { title: 'T' }, 'reviewers', {
    clearable: true,
    valueFor: (v) => [v],
  }),
  s('tasks.create:parentId', tasksRouter.create, { title: 'T' }, 'parentId', { clearable: true, nullable: true }),
  s('tasks.create:status', tasksRouter.create, { title: 'T' }, 'status', { clearable: true, cap: 64 }),
  s('tasks.setStatus:id', tasksRouter.setStatus, { id: 'x', status: 's' }, 'id'),
  s('tasks.setStatus:status', tasksRouter.setStatus, { id: 'x', status: 's' }, 'status'),
  s('tasks.listPaged:statusId', tasksRouter.listPaged, { q: 'a' }, 'statusId', { clearable: true }),
  s('tasks.listPaged:projectId', tasksRouter.listPaged, { q: 'a' }, 'projectId', { clearable: true }),
  s('tasks.listPaged:assigneeId', tasksRouter.listPaged, { q: 'a' }, 'assigneeId', {
    clearable: true,
    blankAllowed: true,
  }),
  s('tasks.subtasks:taskId', tasksRouter.subtasks, { taskId: 'x' }, 'taskId'),
  s('tasks.assignments:taskId', tasksRouter.assignments, { taskId: 'x' }, 'taskId'),
  s('tasks.proposals:taskId', tasksRouter.proposals, { taskId: 'x' }, 'taskId'),
  s('tasks.ask:taskId', tasksRouter.ask, { taskId: 'x', body: 'b' }, 'taskId'),
  s('tasks.note:taskId', tasksRouter.note, { taskId: 'x', body: 'b' }, 'taskId'),
  s('tasks.answer:taskId', tasksRouter.answer, { taskId: 'x', body: 'b' }, 'taskId'),
  s('tasks.submit:taskId', tasksRouter.submit, { taskId: 'x', body: 'b' }, 'taskId'),
  s('tasks.approve:taskId', tasksRouter.approve, { taskId: 'x', body: 'b' }, 'taskId'),
  s('tasks.requestChanges:taskId', tasksRouter.requestChanges, { taskId: 'x', body: 'b' }, 'taskId'),
  s('tasks.reject:taskId', tasksRouter.reject, { taskId: 'x', body: 'b' }, 'taskId'),
  s('tasks.abandon:taskId', tasksRouter.abandon, { taskId: 'x', body: 'b' }, 'taskId'),
  s('tasks.reviews:taskId', tasksRouter.reviews, { taskId: 'x' }, 'taskId'),
  s('tasks.activityList:taskId', tasksRouter.activityList, { taskId: 'x' }, 'taskId'),
  s('tasks.activity:taskId', tasksRouter.activity, { taskId: 'x' }, 'taskId'),
  s('tasks.runsList:taskId', tasksRouter.runsList, { taskId: 'x' }, 'taskId'),
  s('tasks.runs:taskId', tasksRouter.runs, { taskId: 'x' }, 'taskId'),
  s('tasks.getDescription:taskId', tasksRouter.getDescription, { taskId: 'x' }, 'taskId'),
  s('tasks.threadList:taskId', tasksRouter.threadList, { taskId: 'x' }, 'taskId'),
  s('tasks.thread:taskId', tasksRouter.thread, { taskId: 'x' }, 'taskId'),
  s(
    'tasks.threadOlderPage:taskId',
    tasksRouter.threadOlderPage,
    { taskId: 'x', before: { createdAt: 'c', id: 'i' } },
    'taskId',
  ),
  s(
    'tasks.threadOlderPage:before.id',
    tasksRouter.threadOlderPage,
    { taskId: 'x', before: { createdAt: 'c', id: 'i' } },
    'id',
    { leaf: ['before', 'id'], ref: true },
  ),
  s('tasks.runTranscript:runId', tasksRouter.runTranscript, { runId: 'r' }, 'runId'),
  s('tasks.confirmProposal:proposalId', tasksRouter.confirmProposal, { proposalId: 'p' }, 'proposalId'),
  s('tasks.rejectProposal:proposalId', tasksRouter.rejectProposal, { proposalId: 'p' }, 'proposalId'),
  s('tasks.forward:taskId', tasksRouter.forward, { taskId: 'x', toEmployeeId: 'e' }, 'taskId'),
  s('tasks.forward:toEmployeeId', tasksRouter.forward, { taskId: 'x', toEmployeeId: 'e' }, 'toEmployeeId'),
  s('tasks.dispatch:taskId', tasksRouter.dispatch, { taskId: 'x' }, 'taskId'),
  s('tasks.stop:taskId', tasksRouter.stop, { taskId: 'x' }, 'taskId'),
  s('tasks.remove:id', tasksRouter.remove, { id: 'x' }, 'id'),

  // ---- projects ----
  s('projects.create:parentId', projectsRouter.create, { name: 'P' }, 'parentId', { clearable: true, nullable: true }),
  s('projects.update:id', projectsRouter.update, { id: 'x' }, 'id'),
  s('projects.update:parentId', projectsRouter.update, { id: 'x' }, 'parentId', { clearable: true, nullable: true }),
  s('projects.remove:id', projectsRouter.remove, { id: 'x' }, 'id'),

  // ---- task statuses ----
  s('statuses.save:id', statusesRouter.save, { name: 'S', position: 0 }, 'id', { clearable: true, cap: 64 }),
  s('statuses.save:nextIds', statusesRouter.save, { name: 'S', position: 0 }, 'nextIds', {
    clearable: true,
    cap: 64,
    omittedDefault: [],
    valueFor: (v) => [v],
  }),
  s('statuses.remove:id', statusesRouter.remove, { id: 'x' }, 'id'),
  s('statuses.assign:taskId', statusesRouter.assign, { taskId: 'x' }, 'taskId'),

  // ---- model providers ----
  s('providers.save:id', providersRouter.save, providerBase(), 'id', { clearable: true, cap: 64 }),
  s('providers.models:providerId', providersRouter.models, { providerId: 'p' }, 'providerId'),
  s('providers.models:keySecretId', providersRouter.models, { providerId: 'p' }, 'keySecretId', { clearable: true }),
  s('providers.remove:id', providersRouter.remove, { id: 'x' }, 'id'),

  // ---- vault ----
  s('vault.secrets.list:folderId', vaultRouter.secrets.list, {}, 'folderId', { clearable: true, nullable: true }),
  s('vault.secrets.create:folderId', vaultRouter.secrets.create, { name: 'n', value: 'v' }, 'folderId', {
    clearable: true,
    nullable: true,
    omittedDefault: null,
  }),
  s('vault.secrets.update:id', vaultRouter.secrets.update, { id: 'x', name: 'n' }, 'id'),
  s('vault.secrets.update:folderId', vaultRouter.secrets.update, { id: 'x', name: 'n' }, 'folderId', {
    clearable: true,
    nullable: true,
    omittedDefault: null,
  }),
  s('vault.secrets.remove:id', vaultRouter.secrets.remove, { id: 'x' }, 'id'),
  s('vault.folders.save:id', vaultRouter.folders.save, { name: 'n' }, 'id', { clearable: true }),
  s('vault.folders.remove:id', vaultRouter.folders.remove, { id: 'x' }, 'id'),

  // ---- environments ----
  s('environments.create:secretId', environmentsRouter.create, envBase(), 'secretId', {
    clearable: true,
    nullable: true,
    omittedDefault: null,
  }),
  s('environments.update:id', environmentsRouter.update, { id: 'x' }, 'id'),
  s('environments.update:secretId', environmentsRouter.update, { id: 'x' }, 'secretId', {
    clearable: true,
    nullable: true,
  }),
  s('environments.remove:id', environmentsRouter.remove, { id: 'x' }, 'id'),
  s('environments.probe:id', environmentsRouter.probe, { id: 'x' }, 'id', { ref: true }),

  // ---- mcp registry + bindings ----
  s('mcp.registryCreate:oauthClientSecretId', mcpRouter.registryCreate, { name: 'n' }, 'oauthClientSecretId', {
    clearable: true,
    nullable: true,
  }),
  s('mcp.registryUpdate:id', mcpRouter.registryUpdate, { id: 'x' }, 'id'),
  s('mcp.registryUpdate:oauthClientSecretId', mcpRouter.registryUpdate, { id: 'x' }, 'oauthClientSecretId', {
    clearable: true,
    nullable: true,
  }),
  s('mcp.registryRemove:id', mcpRouter.registryRemove, { id: 'x' }, 'id'),
  s('mcp.bindingsListByServer:serverId', mcpRouter.bindingsListByServer, { serverId: 's' }, 'serverId'),
  s('mcp.bindingsSet:employeeId', mcpRouter.bindingsSet, { employeeId: 'e', serverId: 's' }, 'employeeId'),
  s('mcp.bindingsSet:serverId', mcpRouter.bindingsSet, { employeeId: 'e', serverId: 's' }, 'serverId'),
  s('mcp.bindingsSet:secretId', mcpRouter.bindingsSet, { employeeId: 'e', serverId: 's' }, 'secretId', {
    clearable: true,
    nullable: true,
  }),
  s('mcp.bindingsRemove:employeeId', mcpRouter.bindingsRemove, { employeeId: 'e', serverId: 's' }, 'employeeId'),
  s('mcp.bindingsRemove:serverId', mcpRouter.bindingsRemove, { employeeId: 'e', serverId: 's' }, 'serverId'),
  s('mcp.bindingsList:employeeId', mcpRouter.bindingsList, { employeeId: 'e' }, 'employeeId', { blankAllowed: true }),
  s('mcp.probe:employeeId', mcpRouter.probe, { employeeId: 'e', serverId: 's' }, 'employeeId', {
    blankAllowed: true,
  }),
  s('mcp.probe:serverId', mcpRouter.probe, { employeeId: 'e', serverId: 's' }, 'serverId'),
  s('mcp.oauthConnect:employeeId', mcpRouter.oauthConnect, { employeeId: 'e', serverId: 's' }, 'employeeId'),
  s('mcp.oauthConnect:serverId', mcpRouter.oauthConnect, { employeeId: 'e', serverId: 's' }, 'serverId'),

  // ---- channels (config entries validated by the shared schema) ----
  s('channels.update:tokenSecretId', channelsRouter.update, { channels: [channelEntry()] }, 'tokenSecretId', {
    leaf: ['channels', 0, 'tokenSecretId'],
  }),
  s(
    'channels.update:platformUserId',
    channelsRouter.update,
    { channels: [{ ...channelEntry(), bindings: [{ platformUserId: 'u', userId: USER_UUID }] }] },
    'platformUserId',
    { leaf: ['channels', 0, 'bindings', 0, 'platformUserId'] },
  ),

  // ---- oidc provider registry (a store-key id that would mint a new provider) ----
  s(
    'oidc.replace:providers.id',
    oidcRouter.replace,
    {
      providers: [{ id: 'p', label: 'L', issuer: 'https://issuer.test', clientId: 'c', clientSecret: 's' }],
    },
    'id',
    { leaf: ['providers', 0, 'id'], cap: 64, clearable: true },
  ),

  // ---- settings assignment references ----
  s(
    'settings.update:internalLlm.providerId',
    settingsRouter.update,
    { internalLlm: assignment('providerId', 'p') },
    'providerId',
    { leaf: ['internalLlm', 'providerId'] },
  ),
  s('settings.update:internalLlm.model', settingsRouter.update, { internalLlm: assignment('model', 'm') }, 'model', {
    leaf: ['internalLlm', 'model'],
  }),
  s(
    'settings.update:internalLlm.keySecretId',
    settingsRouter.update,
    { internalLlm: assignment('keySecretId', 'k') },
    'keySecretId',
    { leaf: ['internalLlm', 'keySecretId'] },
  ),
  s(
    'settings.update:internalDecision.providerId',
    settingsRouter.update,
    { internalDecision: assignment('providerId', 'p') },
    'providerId',
    { leaf: ['internalDecision', 'providerId'] },
  ),
  s(
    'settings.update:internalDecision.model',
    settingsRouter.update,
    { internalDecision: assignment('model', 'm') },
    'model',
    { leaf: ['internalDecision', 'model'] },
  ),
  s(
    'settings.update:internalDecision.keySecretId',
    settingsRouter.update,
    { internalDecision: assignment('keySecretId', 'k') },
    'keySecretId',
    { leaf: ['internalDecision', 'keySecretId'] },
  ),

  // ---- employees (text ids answer through storableId; `model` is free text) ----
  s('employees.create:supervisorIds', employeesRouter.create, employeeCreateBase(), 'supervisorIds', {
    valueFor: (v) => [v],
    clearable: true,
    omittedDefault: [],
  }),
  s('employees.create:environmentId', employeesRouter.create, employeeCreateBase(), 'environmentId', {
    clearable: true,
  }),
  s('employees.create:providerId', employeesRouter.create, employeeCreateBase(), 'providerId', {
    clearable: true,
    nullable: true,
  }),
  s('employees.create:apiKeySecretId', employeesRouter.create, employeeCreateBase(), 'apiKeySecretId', {
    clearable: true,
    nullable: true,
  }),
  s('employees.update:id', employeesRouter.update, employeeUpdateBase(), 'id'),
  s('employees.update:supervisorIds', employeesRouter.update, employeeUpdateBase(), 'supervisorIds', {
    valueFor: (v) => [v],
  }),
  s('employees.update:environmentId', employeesRouter.update, employeeUpdateBase(), 'environmentId', {
    clearable: true,
    nullable: true,
  }),
  s('employees.update:providerId', employeesRouter.update, employeeUpdateBase(), 'providerId', {
    clearable: true,
    nullable: true,
  }),
  s('employees.update:apiKeySecretId', employeesRouter.update, employeeUpdateBase(), 'apiKeySecretId', {
    clearable: true,
    nullable: true,
  }),
  s('employees.titles.save:id', employeesRouter.titles.save, { name: 'N' }, 'id', { clearable: true }),
  s('employees.titles.remove:id', employeesRouter.titles.remove, {}, 'id'),
  s('employees.remove:id', employeesRouter.remove, {}, 'id'),
  s('employees.createApiKey:employeeId', employeesRouter.createApiKey, {}, 'employeeId'),
  s('employees.updateApiKey:keyId', employeesRouter.updateApiKey, { keyId: 'k', name: 'k' }, 'keyId'),
  s('employees.updateApiKey:employeeId', employeesRouter.updateApiKey, { keyId: 'k', name: 'k' }, 'employeeId', {
    clearable: true,
  }),
  s('employees.revokeApiKey:keyId', employeesRouter.revokeApiKey, { keyId: 'k' }, 'keyId'),
  s('employees.revokeApiKey:employeeId', employeesRouter.revokeApiKey, { keyId: 'k' }, 'employeeId', {
    clearable: true,
  }),
  s('employees.listApiKeys:employeeId', employeesRouter.listApiKeys, {}, 'employeeId', { blankAllowed: true }),
];

const routers: Record<string, unknown> = {
  tasks: tasksRouter,
  projects: projectsRouter,
  statuses: statusesRouter,
  vault: vaultRouter,
  mcp: mcpRouter,
  providers: providersRouter,
  environments: environmentsRouter,
  channels: channelsRouter,
  settings: settingsRouter,
  oidc: oidcRouter,
  employees: employeesRouter,
};

/** 'tasks.note:taskId' → tasksRouter.note, 'vault.secrets.create:folderId' → vaultRouter.secrets.create */
function procedureForLabel(label: string): unknown {
  const [path] = label.split(':');
  const [root, ...rest] = path.split('.');
  let node: unknown = routers[root];
  for (const part of rest) node = (node as Record<string, unknown>)[part];
  return node;
}

/** the input the surface's field carries for a given variant value */
function payload(surface: Surface, value: unknown): Record<string, unknown> {
  if (surface.leaf) return setAt(surface.base, surface.leaf, value);
  const key = surface.inputKey ?? surface.field;
  const mapped = (surface.valueFor ?? ((v: string) => v))(value as string);
  return { ...surface.base, [key]: mapped };
}

type Refusal = { code?: string; data?: { issues?: { path?: (string | number)[]; message?: string }[] } };

async function refusal(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    await run();
  } catch (error) {
    return error as Refusal;
  }
  throw new Error('the call resolved — an unstorable id was accepted');
}

describe('every text-typed id refuses unstorable text (handler-level, #386)', () => {
  for (const surface of surfaces) {
    it(`${surface.surface}: NUL and a lone surrogate answer BAD_REQUEST naming the field`, async () => {
      for (const bad of [NUL, LONE_HIGH, LONE_LOW]) {
        const error = await refusal(() => surface.run(payload(surface, bad)));
        expect(error.code, `${surface.surface} (${JSON.stringify(bad)})`).toBe('BAD_REQUEST');
        const wanted = `${surface.field} contains invalid characters (NUL or a lone surrogate)`;
        const issue = (error.data?.issues ?? []).find((candidate) => (candidate.message ?? '').includes(wanted));
        expect(issue, `${surface.surface} (${JSON.stringify(bad)}) answers the field-named message`).toBeTruthy();
        // the refusal must name THE FIELD THIS ROW LABELS, not a sibling that
        // happens to reject first (a copy-pasted row onto a same-shaped field)
        const segments = (issue?.path ?? []).filter((part): part is string => typeof part === 'string');
        expect(segments[segments.length - 1], `${surface.surface} issue path`).toBe(surface.field.split('.').pop());
      }
    });
  }
});

describe('the id surface table is unique and counted (#386)', () => {
  it('every label appears exactly once (a duplicated row is a silently dropped surface)', () => {
    expect(new Set(surfaces.map((surface) => surface.surface)).size).toBe(surfaces.length);
  });

  it('the table holds 112 rows — bump the count when you add one', () => {
    // 46 tasks + 4 projects + 4 statuses + 4 providers + 7 vault + 5 environments
    // + 15 mcp + 2 channels + 6 settings + 1 oidc + 18 employees = 112
    expect(surfaces).toHaveLength(112);
  });
});

// ---- completeness: a surface MISSING from the table must red the suite ----
// The count assertion above is a self-count — it cannot see a procedure the
// table never named (the exact shape #386's oidc gap shipped in). This walk
// enumerates the REAL app router's text-typed leaves, keyed by their FULL PATH,
// and requires each one to be a table row or a named exemption.

type Leaf = { path: string; schema: unknown };

type ZodDef = {
  type?: string;
  shape?: Record<string, unknown>;
  element?: unknown;
  options?: unknown[];
  innerType?: unknown;
  checks?: { def?: { format?: string } }[];
  valueType?: unknown;
  items?: unknown[];
  left?: unknown;
  right?: unknown;
  getter?: () => unknown;
  in?: unknown;
  out?: unknown;
  catchall?: unknown;
};

function defOf(schema: unknown): ZodDef | null {
  return (schema as { _zod?: { def?: ZodDef } })?._zod?.def ?? null;
}

/** strip transparent wrappers but NEVER consume a pipe (both halves matter) */
function unwrapWrappers(schema: unknown): ZodDef | null {
  let def = defOf(schema);
  for (let guard = 0; guard < 10 && def; guard += 1) {
    const type = def.type;
    if (
      type === 'optional' ||
      type === 'nullable' ||
      type === 'default' ||
      type === 'readonly' ||
      type === 'catch' ||
      type === 'nonoptional'
    ) {
      def = defOf(def.innerType);
    } else {
      return def;
    }
  }
  return def ?? null;
}

/** id-shaped leaf names: the id class plus the reference names the SPEC sweeps */
const REFERENCE_LEAF = /(^id$|Ids?$|^status$|^model$|^reviewers$)/;

/** id-ish text leaves as FULL dotted paths (array indices dropped — they are
 *  positions, not field identity; a record/tuple/catchall value keeps a '*') */
function collectIdLeafPaths(schema: unknown, path: string[], out: Leaf[]): void {
  const raw = unwrapWrappers(schema);
  if (!raw) return;
  if (raw.type === 'pipe') {
    collectIdLeafPaths(raw.in, path, out);
    collectIdLeafPaths(raw.out, path, out);
    return;
  }
  const type = raw.type;
  if (type === 'custom' || type === 'function') {
    throw new Error(`text-id walk: opaque '${type}' at ${path.join('.') || '<root>'}`);
  }
  if ((type === 'array' || type === 'record' || type === 'tuple') && path.length === 0) {
    throw new Error(`text-id walk: root ${type} input cannot be named`);
  }
  if (type === 'string' && path.length === 0) {
    throw new Error('text-id walk: a root scalar input cannot be named');
  }
  if (type === 'object' && raw.shape) {
    for (const [key, child] of Object.entries(raw.shape)) collectIdLeafPaths(child, [...path, key], out);
    if (raw.catchall) {
      // a catchall map named like a reference (ghostIds) is the reference
      const name = path[path.length - 1] ?? '';
      if (REFERENCE_LEAF.test(name)) out.push({ path: path.filter((p) => p !== '*').join('.'), schema });
      else collectIdLeafPaths(raw.catchall, [...path, '*'], out);
    }
    return;
  }
  if (type === 'array' && raw.element) {
    collectIdLeafPaths(raw.element, path, out);
    return;
  }
  if (type === 'union' && raw.options) {
    for (const option of raw.options) collectIdLeafPaths(option, path, out);
    return;
  }
  if (type === 'record' || type === 'tuple') {
    const name = path[path.length - 1] ?? '';
    if (REFERENCE_LEAF.test(name)) {
      out.push({ path: path.filter((p) => p !== '*').join('.'), schema });
      return;
    }
    if (type === 'record' && raw.valueType) {
      collectIdLeafPaths(raw.valueType, [...path, '*'], out);
      return;
    }
    for (const item of raw.items ?? []) collectIdLeafPaths(item, [...path, '*'], out);
    return;
  }
  if (type === 'intersection') {
    collectIdLeafPaths(raw.left, path, out);
    collectIdLeafPaths(raw.right, path, out);
    return;
  }
  if (type === 'lazy' && raw.getter) {
    collectIdLeafPaths(raw.getter(), path, out);
    return;
  }
  if (type === 'transform') {
    // the out-half of a pipe (already walked through `in`); a bare transform
    // has no input contract to inspect
    if (raw.in) collectIdLeafPaths(raw.in, path, out);
    return;
  }
  if (type === 'string') {
    // a format guard (uuid / email) already refuses a NUL before any query —
    // that is the ID-SHAPE carve-out, not a text-id surface
    const formatGuarded = (raw.checks ?? []).some((check) => check.def?.format !== undefined);
    if (formatGuarded) return;
    const leaf = path[path.length - 1] ?? '';
    if (REFERENCE_LEAF.test(leaf)) out.push({ path: path.filter((p) => p !== '*').join('.'), schema });
    return;
  }
  // any other container that can hide a string leaf must be taught to this walk
  if (raw.shape || raw.element || raw.options || raw.valueType || raw.items || raw.catchall) {
    throw new Error(`text-id walk: unhandled composite '${String(type)}' at ${path.join('.')}`);
  }
}

/** leaves that carry a REFERENCE but are not row keys — named with the reason */
const EXEMPT_ID_LEAVES: Record<string, string> = {
  'mcp.registryCreate:oauthClientId': 'OAuth client id — a credential value guarded by storable(...), never a row key',
  'mcp.registryUpdate:oauthClientId': 'OAuth client id — a credential value guarded by storable(...), never a row key',
  'oidc.replace:providers.clientId': 'OAuth client id — a credential value guarded by storable(...), never a row key',
  'employees.create:model': 'a free-text model name guarded by storableText(...), not an id',
  'employees.update:model': 'a free-text model name guarded by storableText(...), not an id',
};

type ProcedureEntry = { name: string; procedure: Record<string, unknown> };

function collectProcedures(node: unknown, prefix: string, out: ProcedureEntry[]): void {
  if (!node || typeof node !== 'object') return;
  const orpc = (node as Record<string, unknown>)['~orpc'] as Record<string, unknown> | undefined;
  if (orpc && !orpc.router) {
    out.push({ name: prefix, procedure: node as Record<string, unknown> });
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    collectProcedures(child, prefix ? `${prefix}.${key}` : key, out);
  }
}

/** the table's identity for a surface: procedure + the FULL field path it drives */
function coverageKey(surface: Surface): string {
  const [procedure] = surface.surface.split(':');
  const path = (surface.leaf ?? [surface.field]).filter((part): part is string => typeof part === 'string');
  return `${procedure}:${path.join('.')}`;
}

/** id-ish leaves the real app router declares, with the procedures that carry them */
function routerIdLeaves(): { name: string; procedure: Record<string, unknown>; leaves: Leaf[] }[] {
  const entries: ProcedureEntry[] = [];
  collectProcedures(appRouter, '', entries);
  return entries.map(({ name, procedure }) => {
    const schemas = (procedure['~orpc'] as { inputSchemas?: unknown[] }).inputSchemas ?? [];
    const leaves: Leaf[] = [];
    for (const schema of schemas) collectIdLeafPaths(schema, [], leaves);
    return { name, procedure, leaves };
  });
}

describe('the id table covers the app router (a missing surface reds the suite, #386)', () => {
  it('the walk and the table describe EXACTLY the same leaves (plus named exemptions)', () => {
    const entries = routerIdLeaves();
    expect(entries.length).toBeGreaterThan(90); // the walk itself must not silently find nothing

    const covered = new Set(surfaces.map(coverageKey));
    const discovered = new Set(entries.flatMap((entry) => entry.leaves.map((leaf) => `${entry.name}:${leaf.path}`)));
    const expected = new Set([...covered, ...Object.keys(EXEMPT_ID_LEAVES)]);

    // both directions: a leaf with no row (or exemption) reds, and a row whose
    // leaf the walk no longer sees reds (a lost walk branch cannot hide)
    expect([...discovered].filter((key) => !expected.has(key)).sort()).toEqual([]);
    expect([...expected].filter((key) => !discovered.has(key)).sort()).toEqual([]);
  });

  it('the walk visits every top-level router (a whole domain cannot drop out)', () => {
    const entries = routerIdLeaves();
    const roots = new Set(entries.map((entry) => entry.name.split('.')[0]));
    for (const root of Object.keys(appRouter)) {
      expect(roots.has(root), `router '${root}' contributed no procedures to the walk`).toBe(true);
    }
  });

  it('the table rows are names for the fields they actually drive', () => {
    for (const surface of surfaces) {
      const [, labelField = ''] = surface.surface.split(':');
      expect(labelField.split('.').pop(), `${surface.surface} label names its field`).toBe(surface.field);
    }
    expect(new Set(surfaces.map(coverageKey)).size, 'two rows cover the same leaf').toBe(surfaces.length);
  });

  it('every table procedure is one the app router mounts', () => {
    // os.router() wraps each procedure, so identity cannot be compared — the
    // NAME is the mount surface: unmounting a router removes its names
    const mounted = new Set(routerIdLeaves().map((entry) => entry.name));
    for (const surface of surfaces) {
      expect(mounted.has(surface.surface.split(':')[0]), `${surface.surface} is mounted`).toBe(true);
    }
  });

  it('every exemption carries the guard its reason claims (NUL is refused there)', () => {
    const entries = routerIdLeaves();
    for (const key of Object.keys(EXEMPT_ID_LEAVES)) {
      const [procedure, leafPath = ''] = key.split(':');
      const entry = entries.find((candidate) => candidate.name === procedure);
      const leaf = entry?.leaves.find((candidate) => candidate.path === leafPath);
      expect(leaf, `${key} is a live leaf`).toBeTruthy();
      const parsed = (leaf?.schema as { safeParse: (value: unknown) => { success: boolean } }).safeParse(NUL);
      expect(parsed.success, `${key} refuses NUL through its own guard`).toBe(false);
    }
  });
});

describe('the walker handles every composite node type (#386 vacuity)', () => {
  const cases: [string, unknown, string[]][] = [
    ['object', z.object({ taskId: z.string() }), ['taskId']],
    ['array', z.array(z.object({ taskId: z.string() })), ['taskId']],
    ['union', z.union([z.object({ taskId: z.string() }), z.string()]), ['taskId']],
    ['record', z.record(z.string(), z.object({ taskId: z.string() })), ['taskId']],
    ['tuple', z.tuple([z.object({ taskId: z.string() })]), ['taskId']],
    ['intersection', z.intersection(z.object({ taskId: z.string() }), z.object({ x: z.string() })), ['taskId']],
    ['lazy', z.lazy(() => z.object({ taskId: z.string() })), ['taskId']],
    ['optional', z.object({ taskId: z.string() }).optional(), ['taskId']],
    ['catch', z.object({ taskId: z.string() }).catch({}), ['taskId']],
    ['pipe', z.object({ taskId: z.string() }).transform((value) => value), ['taskId']],
    ['preprocess', z.preprocess((value) => value, z.object({ taskId: z.string() })), ['taskId']],
    ['catchall', z.object({}).catchall(z.string()), []],
  ];

  for (const [label, schema, expected] of cases) {
    it(`${label} yields ${expected.join(',') || 'no named leaf'}`, () => {
      const leaves: Leaf[] = [];
      collectIdLeafPaths(schema, ['input'], leaves);
      expect(leaves.map((leaf) => leaf.path)).toEqual(expected.map((path) => `input.${path}`));
    });
  }

  it('a named catchall map is the reference itself', () => {
    const leaves: Leaf[] = [];
    collectIdLeafPaths(z.object({ ghostIds: z.object({}).catchall(z.string()) }), [], leaves);
    expect(leaves.map((leaf) => leaf.path)).toEqual(['ghostIds']);
  });
});
describe('the id surface table points at the procedure its label names (#386)', () => {
  for (const surface of surfaces) {
    it(`${surface.surface}: label and procedure agree`, () => {
      // a copy-paste slip onto a same-shaped sibling would otherwise leave the
      // swapped-out procedure unpinned while staying green
      expect(procedureForLabel(surface.surface)).toBe(surface.procedure);
    });
  }
});

describe('the wired id schema keeps its own contract (#386: accept / blank / clear / null / cap)', () => {
  for (const surface of surfaces) {
    const schema = () => schemaOf(surface.procedure);

    it(`${surface.surface}: a storable astral id stays accepted`, () => {
      expect(schema().safeParse(payload(surface, ASTRAL)).success).toBe(true);
    });

    it(`${surface.surface}: a blank id is ${surface.blankAllowed ? 'accepted (filter law)' : 'refused (no min(1) drop)'}`, () => {
      // the non-blank half of storableId: swapping it for a bare `storable(...)`
      // would let '' reach an upsert-by-id write and create a new row
      expect(schema().safeParse(payload(surface, '')).success).toBe(surface.blankAllowed === true);
      // whitespace-only is the same create-a-row hazard: the upsert writes trim
      // the id, so '   ' becomes '' and mints a NEW row instead of updating
      if (!surface.blankAllowed) {
        for (const blank of ['   ', '\t', '\u200b']) {
          const parsed = schema().safeParse(payload(surface, blank));
          expect(parsed.success, `${surface.surface} blank ${JSON.stringify(blank)}`).toBe(false);
          const messages = ((parsed as { error?: { issues?: { message?: string }[] } }).error?.issues ?? [])
            .map((issue) => issue.message ?? '')
            .join(' | ');
          expect(messages, `${surface.surface} blank message`).toContain(`${surface.field} must not be blank`);
        }
        // a PADDED id misses its own row in a JS set compare — a store key
        // (`id` / `nextIds`) would mint a fresh row instead of updating the
        // named one, so those refuse; a READ key stays an ordinary miss
        const padRefused = (surface.field === 'id' || surface.field === 'nextIds') && surface.ref !== true;
        const padded = schema().safeParse(payload(surface, ' a '));
        expect(padded.success, `${surface.surface} padded id (${padRefused ? 'refused' : 'a miss'})`).toBe(!padRefused);
        if (padRefused) {
          const paddedMessages = ((padded as { error?: { issues?: { message?: string }[] } }).error?.issues ?? [])
            .map((issue) => issue.message ?? '')
            .join(' | ');
          expect(paddedMessages, `${surface.surface} padded message`).toContain(
            `${surface.field} must not be padded with whitespace`,
          );
          // an invisible EDGE char is the same mint hazard as a space
          expect(schema().safeParse(payload(surface, '\u200bbacklog')).success).toBe(false);
          // ...but a grapheme-extending edge (VS16) is part of a legal id
          expect(schema().safeParse(payload(surface, 'x\u2764\ufe0f')).success).toBe(true);
        }
      }
    });

    if (surface.cap !== undefined) {
      it(`${surface.surface}: the ${surface.cap}-cap literal is exact`, () => {
        expect(schema().safeParse(payload(surface, 'a'.repeat(surface.cap as number))).success).toBe(true);
        expect(schema().safeParse(payload(surface, 'a'.repeat((surface.cap as number) + 1))).success).toBe(false);
      });
    }

    if (surface.clearable) {
      it(`${surface.surface}: the omitted path still parses`, () => {
        const key = surface.inputKey ?? surface.field;
        const path = surface.leaf ?? [key];
        const parsed = schema().safeParse(deleteAt(surface.base, path));
        expect(parsed.success).toBe(true);
        // success alone is not enough: an `.optional()` -> `.default(x)` swap
        // keeps the parse green while rewriting the stored value on every call
        const data = (parsed as { data: Record<string, unknown> }).data;
        if (surface.omittedDefault !== undefined) expect(getAt(data, path)).toEqual(surface.omittedDefault);
        else expect(getAt(data, path)).toBeUndefined();
      });
    }

    if (!surface.clearable) {
      it(`${surface.surface}: omitting the field is refused (no required -> optional drift)`, () => {
        const path = surface.leaf ?? [surface.inputKey ?? surface.field];
        expect(schema().safeParse(deleteAt(surface.base, path)).success).toBe(false);
      });
    }

    if (!surface.nullable) {
      it(`${surface.surface}: an explicit null is refused (no widening to nullish)`, () => {
        const path = surface.leaf ?? [surface.inputKey ?? surface.field];
        expect(schema().safeParse(setAt(surface.base, path, null)).success).toBe(false);
      });
    }

    if (surface.nullable) {
      it(`${surface.surface}: an explicit null still parses`, () => {
        const key = surface.inputKey ?? surface.field;
        const path = surface.leaf ?? [key];
        const parsed = schema().safeParse(setAt(surface.base, path, null));
        expect(parsed.success).toBe(true);
        expect(getAt((parsed as unknown as { data: unknown }).data, path)).toBeNull();
      });
    }
  }
});
