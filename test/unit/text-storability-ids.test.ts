// TEXT-STORABILITY LAW (#386, SPEC "API law"): every TEXT-TYPED ID parameter —
// read key, write target, store key or list filter — refuses NUL and unpaired
// surrogates at the procedure edge with the field-named BAD_REQUEST, before the
// value can reach a query parameter (a NUL raises at the driver; a lone
// surrogate is rewritten to U+FFFD and the read misses on a corrupted value,
// while the two upsert-by-id writes would create a NEW row under the corrupted
// id). Handler-level pins below call the REAL oRPC procedures; input validation
// fires before any db access, so a refusal never needs a database. The accept /
// clear / null / cap axes ride the same wired input schema.
import { createProcedureClient } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';

import { ROLE } from '#shared/enums';

// humanProcedure resolves the credential origin through the db — these pins are
// about schema edges, and a unit test must not depend on a live database
vi.mock('../../server/domains/kernel/session-origin', () => ({ isApiKeySession: async () => false }));

import { environmentsRouter } from '../../server/domains/environments/environments.router';
import { mcpRouter } from '../../server/domains/mcp/mcp.router';
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

type Surface = {
  /** procedure label used in the assertion output */
  surface: string;
  procedure: unknown;
  run: (input: unknown) => Promise<unknown>;
  /** a minimal input that passes every OTHER rule (validation only — the handler never runs on refusal) */
  base: Record<string, unknown>;
  /** the text field under test */
  field: string;
  /** a pre-existing cap on the id value, when the field has one */
  cap?: number;
  /** true when the field is optional and its omitted path must stay open */
  clearable?: boolean;
  /** true when the field also accepts an explicit null */
  nullable?: boolean;
  /** the value an OMITTED field parses to when the schema carries a default */
  omittedDefault?: unknown;
  /** build the field value from the payload variant (defaults to the string itself) */
  valueFor?: (value: string) => unknown;
  /** the input key carrying the value when it differs from the field label */
  inputKey?: string;
};

const s = (surface: string, procedure: unknown, base: Record<string, unknown>, field: string, extra: Partial<Surface> = {}): Surface => ({
  surface,
  procedure,
  run: client(procedure),
  base,
  field,
  ...extra,
});

const providerBase = () => ({ label: 'L', baseUrl: 'https://provider.test', endpoints: ['OPENAI-COMPLETIONS'] });
const envBase = () => ({ name: 'n', host: 'host.test', port: '22', username: 'u' });
const llmRef = (field: 'providerId' | 'model' | 'keySecretId') => (value: string) => ({
  providerId: field === 'providerId' ? value : 'p',
  model: field === 'model' ? value : 'm',
  keySecretId: field === 'keySecretId' ? value : 'k',
});

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
  s('tasks.create:reviewers', tasksRouter.create, { title: 'T' }, 'reviewers', { clearable: true, valueFor: (v) => [v] }),
  s('tasks.create:parentId', tasksRouter.create, { title: 'T' }, 'parentId', { clearable: true, nullable: true }),
  s('tasks.create:status', tasksRouter.create, { title: 'T' }, 'status', { clearable: true, cap: 64 }),
  s('tasks.setStatus:id', tasksRouter.setStatus, { id: 'x', status: 's' }, 'id'),
  s('tasks.setStatus:status', tasksRouter.setStatus, { id: 'x', status: 's' }, 'status'),
  s('tasks.listPaged:statusId', tasksRouter.listPaged, { q: 'a' }, 'statusId', { clearable: true }),
  s('tasks.listPaged:projectId', tasksRouter.listPaged, { q: 'a' }, 'projectId', { clearable: true }),
  s('tasks.listPaged:assigneeId', tasksRouter.listPaged, { q: 'a' }, 'assigneeId', { clearable: true }),
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
  s('tasks.threadOlderPage:taskId', tasksRouter.threadOlderPage, {
    taskId: 'x',
    before: { createdAt: 'c', id: 'i' },
  }, 'taskId'),
  s('tasks.threadOlderPage:before.id', tasksRouter.threadOlderPage, {
    taskId: 'x',
    before: { createdAt: 'c', id: 'i' },
  }, 'id', {
    inputKey: 'before',
    valueFor: (v) => ({ createdAt: '2026-01-01T00:00:00.000Z', id: v }),
  }),
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
  s('environments.probe:id', environmentsRouter.probe, { id: 'x' }, 'id'),

  // ---- mcp registry + bindings ----
  s('mcp.registryCreate:oauthClientSecretId', mcpRouter.registryCreate, { name: 'n' }, 'oauthClientSecretId', {
    clearable: true,
    nullable: true,
  }),
  s('mcp.registryUpdate:id', mcpRouter.registryUpdate, { id: 'x' }, 'id'),
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
  s('mcp.bindingsList:employeeId', mcpRouter.bindingsList, { employeeId: 'e' }, 'employeeId'),
  s('mcp.probe:employeeId', mcpRouter.probe, { employeeId: 'e', serverId: 's' }, 'employeeId'),
  s('mcp.probe:serverId', mcpRouter.probe, { employeeId: 'e', serverId: 's' }, 'serverId'),
  s('mcp.oauthConnect:employeeId', mcpRouter.oauthConnect, { employeeId: 'e', serverId: 's' }, 'employeeId'),
  s('mcp.oauthConnect:serverId', mcpRouter.oauthConnect, { employeeId: 'e', serverId: 's' }, 'serverId'),

  // ---- settings assignment references ----
  s('settings.update:internalLlm.providerId', settingsRouter.update, {}, 'providerId', {
    inputKey: 'internalLlm',
    clearable: true,
    nullable: true,
    valueFor: llmRef('providerId'),
  }),
  s('settings.update:internalLlm.model', settingsRouter.update, {}, 'model', {
    inputKey: 'internalLlm',
    clearable: true,
    nullable: true,
    valueFor: llmRef('model'),
  }),
  s('settings.update:internalLlm.keySecretId', settingsRouter.update, {}, 'keySecretId', {
    inputKey: 'internalLlm',
    clearable: true,
    nullable: true,
    valueFor: llmRef('keySecretId'),
  }),
  s('settings.update:internalDecision.providerId', settingsRouter.update, {}, 'providerId', {
    inputKey: 'internalDecision',
    clearable: true,
    nullable: true,
    valueFor: llmRef('providerId'),
  }),
  s('settings.update:internalDecision.model', settingsRouter.update, {}, 'model', {
    inputKey: 'internalDecision',
    clearable: true,
    nullable: true,
    valueFor: llmRef('model'),
  }),
  s('settings.update:internalDecision.keySecretId', settingsRouter.update, {}, 'keySecretId', {
    inputKey: 'internalDecision',
    clearable: true,
    nullable: true,
    valueFor: llmRef('keySecretId'),
  }),
];

const routers: Record<string, unknown> = {
  tasks: tasksRouter,
  projects: projectsRouter,
  statuses: statusesRouter,
  vault: vaultRouter,
  mcp: mcpRouter,
  providers: providersRouter,
  environments: environmentsRouter,
  settings: settingsRouter,
};

/** 'tasks.note:taskId' → tasksRouter.note, 'vault.secrets.create:folderId' → vaultRouter.secrets.create */
function procedureForLabel(label: string): unknown {
  const [path] = label.split(':');
  const [root, ...rest] = path.split('.');
  let node: unknown = routers[root];
  for (const part of rest) node = (node as Record<string, unknown>)[part];
  return node;
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
        const error = await refusal(() =>
          surface.run({
            ...surface.base,
            [surface.inputKey ?? surface.field]: (surface.valueFor ?? ((v: string) => v))(bad),
          }),
        );
        expect(error.code, `${surface.surface} (${JSON.stringify(bad)})`).toBe('BAD_REQUEST');
        const messages = (error.data?.issues ?? []).map((issue) => issue.message ?? '');
        expect(messages.join(' | ')).toContain(`${surface.field} contains invalid characters (NUL or a lone surrogate)`);
      }
    });
  }
});

describe('the id surface table is unique and counted (#386)', () => {
  it('every label appears exactly once (a duplicated row is a silently dropped surface)', () => {
    expect(new Set(surfaces.map((surface) => surface.surface)).size).toBe(surfaces.length);
  });

  it('the table holds 90 rows — bump the count when you add one', () => {
    // 46 tasks + 4 projects + 4 statuses + 4 providers + 7 vault + 5 environments
    // + 14 mcp + 6 settings = 90
    expect(surfaces).toHaveLength(90);
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

describe('the wired id schema keeps its own contract (#386: accept / clear / null / cap)', () => {
  for (const surface of surfaces) {
    const schema = () => schemaOf(surface.procedure);

    it(`${surface.surface}: a storable astral id stays accepted`, () => {
      const value = (surface.valueFor ?? ((v: string) => v))(ASTRAL);
      expect(schema().safeParse({ ...surface.base, [surface.inputKey ?? surface.field]: value }).success).toBe(true);
    });

    if (surface.cap !== undefined) {
      it(`${surface.surface}: the ${surface.cap}-cap literal is exact`, () => {
        const at = (surface.valueFor ?? ((v: string) => v))('a'.repeat(surface.cap as number));
        const over = (surface.valueFor ?? ((v: string) => v))('a'.repeat((surface.cap as number) + 1));
        expect(schema().safeParse({ ...surface.base, [surface.inputKey ?? surface.field]: at }).success).toBe(true);
        expect(schema().safeParse({ ...surface.base, [surface.inputKey ?? surface.field]: over }).success).toBe(false);
      });
    }

    if (surface.clearable) {
      it(`${surface.surface}: the omitted path still parses`, () => {
        const key = surface.inputKey ?? surface.field;
        const cleared = { ...surface.base };
        delete cleared[key];
        const parsed = schema().safeParse(cleared);
        expect(parsed.success).toBe(true);
        // success alone is not enough: an `.optional()` -> `.default(x)` swap
        // keeps the parse green while rewriting the stored value on every call
        const data = (parsed as { data: Record<string, unknown> }).data;
        if (surface.omittedDefault !== undefined) expect(data[key]).toEqual(surface.omittedDefault);
        else expect(Object.prototype.hasOwnProperty.call(data, key)).toBe(false);
      });
    }

    if (!surface.clearable) {
      it(`${surface.surface}: omitting the field is refused (no required -> optional drift)`, () => {
        const key = surface.inputKey ?? surface.field;
        const omitted = { ...surface.base };
        delete omitted[key];
        expect(schema().safeParse(omitted).success).toBe(false);
      });
    }

    if (!surface.nullable) {
      it(`${surface.surface}: an explicit null is refused (no widening to nullish)`, () => {
        const key = surface.inputKey ?? surface.field;
        expect(schema().safeParse({ ...surface.base, [key]: null }).success).toBe(false);
      });
    }

    if (surface.nullable) {
      it(`${surface.surface}: an explicit null still parses`, () => {
        const key = surface.inputKey ?? surface.field;
        const parsed = schema().safeParse({ ...surface.base, [key]: null });
        expect(parsed.success).toBe(true);
        expect((parsed as { data: Record<string, unknown> }).data[key]).toBeNull();
      });
    }
  }
});
