// TEXT-STORABILITY LAW (#382, SPEC "API law"): every user-supplied text value
// that lands raw in a Postgres text column refuses NUL and unpaired surrogates
// at the procedure edge — BAD_REQUEST naming the field, never an opaque driver
// 500 and never a silent U+FFFD rewrite. Handler-level pins below call the REAL
// oRPC procedures (input validation fires before any db access). The schema
// axes ride the same wired input schema (`~orpc.inputSchemas[0]`): a well-formed
// astral pair stays accepted, the pre-existing cap literals stay exact, and
// every clear path stays open.
import { createProcedureClient } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';

import { ROLE } from '#shared/enums';
import { hasUnstorableText } from '#shared/utils/storable-text';

// humanProcedure resolves the credential origin through the db — the pins here
// are about schema edges, and a unit test must not depend on a live database
vi.mock('../../server/domains/kernel/session-origin', () => ({ isApiKeySession: async () => false }));

import { employeesRouter } from '../../server/domains/employees/employees.router';
import { environmentsRouter } from '../../server/domains/environments/environments.router';
import { mcpRouter } from '../../server/domains/mcp/mcp.router';
import { projectsRouter } from '../../server/domains/projects/projects.router';
import { providersRouter } from '../../server/domains/providers/providers.router';
import { settingsRouter } from '../../server/domains/settings/settings.router';
import { statusesRouter } from '../../server/domains/statuses/statuses.router';
import { tasksRouter } from '../../server/domains/tasks/tasks.router';
import { lastFourHint } from '../../server/domains/vault/secret/secret-crypto.service';
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
  // one wired input schema per procedure: a second .input() would silently move
  // the field under test out of index 0 and leave every schema pin green
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
  /** the pre-existing cap literal, when the field has one */
  cap?: number;
  /** true when the field is optional and its clear path must stay open */
  clearable?: boolean;
  /** true when the field also accepts an explicit null */
  nullable?: boolean;
  /** the value an OMITTED field parses to when the schema carries a .default() */
  omittedDefault?: string;
  /** build the field value from the payload variant (defaults to the string itself) */
  valueFor?: (value: string) => unknown;
  /** the input key carrying the value when it differs from the field label (record sub-fields) */
  inputKey?: string;
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

const surfaces: Surface[] = [
  // ---- tasks: create/update + every thread body + proposal notes + list filter ----
  s('tasks.create:title', tasksRouter.create, { title: 'T' }, 'title', { cap: 200 }),
  s('tasks.create:description', tasksRouter.create, { title: 'T' }, 'description', { cap: 10_000, clearable: true }),
  s('tasks.update:title', tasksRouter.update, { id: 'x' }, 'title', { cap: 200, clearable: true }),
  s('tasks.update:description', tasksRouter.update, { id: 'x' }, 'description', {
    cap: 10_000,
    clearable: true,
    nullable: true,
  }),
  s('tasks.note:body', tasksRouter.note, { taskId: 'x', body: 'b' }, 'body', { cap: 10_000 }),
  s('tasks.ask:body', tasksRouter.ask, { taskId: 'x', body: 'b' }, 'body', { cap: 4_000 }),
  s('tasks.forward:body', tasksRouter.forward, { taskId: 'x', toEmployeeId: 'y', body: 'b' }, 'body', {
    cap: 4_000,
    clearable: true,
  }),
  s('tasks.answer:body', tasksRouter.answer, { taskId: 'x', body: 'b' }, 'body', { cap: 10_000 }),
  s('tasks.submit:body', tasksRouter.submit, { taskId: 'x', body: 'b' }, 'body', { cap: 10_000, clearable: true }),
  s('tasks.approve:body', tasksRouter.approve, { taskId: 'x', body: 'b' }, 'body', { cap: 4_000, clearable: true }),
  s('tasks.requestChanges:body', tasksRouter.requestChanges, { taskId: 'x', body: 'b' }, 'body', { cap: 10_000 }),
  s('tasks.reject:body', tasksRouter.reject, { taskId: 'x', body: 'b' }, 'body', { cap: 4_000, clearable: true }),
  s('tasks.abandon:body', tasksRouter.abandon, { taskId: 'x', body: 'b' }, 'body', { cap: 4_000, clearable: true }),
  s('tasks.confirmProposal:note', tasksRouter.confirmProposal, { proposalId: 'p', note: 'n' }, 'note', {
    cap: 2000,
    clearable: true,
  }),
  s('tasks.rejectProposal:note', tasksRouter.rejectProposal, { proposalId: 'p', note: 'n' }, 'note', {
    cap: 2000,
    clearable: true,
  }),
  s('tasks.listPaged:q', tasksRouter.listPaged, { q: 'a' }, 'q', { clearable: true }),

  // ---- projects ----
  s('projects.create:name', projectsRouter.create, { name: 'P' }, 'name', { cap: 120 }),
  s('projects.create:description', projectsRouter.create, { name: 'P' }, 'description', {
    cap: 2000,
    clearable: true,
    omittedDefault: '',
  }),
  s('projects.create:prompt', projectsRouter.create, { name: 'P' }, 'prompt', {
    cap: 8000,
    clearable: true,
    omittedDefault: '',
  }),
  s('projects.update:name', projectsRouter.update, { id: 'x' }, 'name', { cap: 120, clearable: true }),
  s('projects.update:description', projectsRouter.update, { id: 'x' }, 'description', { cap: 2000, clearable: true }),
  s('projects.update:prompt', projectsRouter.update, { id: 'x' }, 'prompt', { cap: 8000, clearable: true }),

  // ---- task statuses ----
  s('statuses.save:name', statusesRouter.save, { name: 'S', position: 0 }, 'name', { cap: 64 }),

  // ---- vault secrets + folders ----
  s('vault.secrets.create:name', vaultRouter.secrets.create, { name: 'n', value: 'v' }, 'name', { cap: 100 }),
  s('vault.secrets.create:description', vaultRouter.secrets.create, { name: 'n', value: 'v' }, 'description', {
    cap: 500,
    clearable: true,
    omittedDefault: '',
  }),
  s('vault.secrets.create:value', vaultRouter.secrets.create, { name: 'n', value: 'v' }, 'value', { cap: 64_000 }),
  s('vault.secrets.update:name', vaultRouter.secrets.update, { id: 'x', name: 'n' }, 'name', { cap: 100 }),
  s('vault.secrets.update:description', vaultRouter.secrets.update, { id: 'x', name: 'n' }, 'description', {
    cap: 500,
    clearable: true,
    // pre-existing contract: an omitted description CES parses to '' (documented,
    // not changed here — this PR is about storability, not partial-update semantics)
    omittedDefault: '',
  }),
  s('vault.secrets.update:value', vaultRouter.secrets.update, { id: 'x', name: 'n' }, 'value', {
    cap: 64_000,
    clearable: true,
  }),
  s('vault.secrets.list:q', vaultRouter.secrets.list, { q: 'a' }, 'q', { cap: 200, clearable: true }),
  s('vault.folders.save:name', vaultRouter.folders.save, { name: 'n' }, 'name', { cap: 60 }),
  s('vault.folders.listPaged:q', vaultRouter.folders.listPaged, { q: 'a' }, 'q', { cap: 60, clearable: true }),
  s('vault.folders.options:q', vaultRouter.folders.options, { q: 'a' }, 'q', { clearable: true }),

  // ---- mcp registry ----
  s('mcp.registryCreate:name', mcpRouter.registryCreate, { name: 'n' }, 'name', { cap: 200 }),
  s('mcp.registryCreate:notes', mcpRouter.registryCreate, { name: 'n' }, 'notes', {
    cap: 2000,
    clearable: true,
    omittedDefault: '',
  }),
  s('mcp.registryCreate:command', mcpRouter.registryCreate, { name: 'n', command: 'run' }, 'command', {
    clearable: true,
    nullable: true,
  }),
  s('mcp.registryCreate:oauthScopes', mcpRouter.registryCreate, { name: 'n' }, 'oauthScopes', {
    cap: 500,
    clearable: true,
    nullable: true,
  }),
  s('mcp.registryCreate:oauthClientId', mcpRouter.registryCreate, { name: 'n' }, 'oauthClientId', {
    cap: 500,
    clearable: true,
    nullable: true,
  }),
  s('mcp.registryUpdate:name', mcpRouter.registryUpdate, { id: 'x' }, 'name', { cap: 200, clearable: true }),
  s('mcp.registryUpdate:notes', mcpRouter.registryUpdate, { id: 'x' }, 'notes', {
    cap: 2000,
    clearable: true,
    omittedDefault: '',
  }),
  s('mcp.registryUpdate:command', mcpRouter.registryUpdate, { id: 'x', command: 'run' }, 'command', {
    clearable: true,
    nullable: true,
  }),
  s('mcp.registryUpdate:oauthScopes', mcpRouter.registryUpdate, { id: 'x' }, 'oauthScopes', {
    cap: 500,
    clearable: true,
    nullable: true,
  }),
  s('mcp.registryUpdate:oauthClientId', mcpRouter.registryUpdate, { id: 'x' }, 'oauthClientId', {
    cap: 500,
    clearable: true,
    nullable: true,
  }),
  s('mcp.registryCreate:url', mcpRouter.registryCreate, { name: 'n' }, 'url', {
    clearable: true,
    nullable: true,
    valueFor: urlWith,
  }),
  s('mcp.registryCreate:oauthAuthorizeUrl', mcpRouter.registryCreate, { name: 'n' }, 'oauthAuthorizeUrl', {
    clearable: true,
    nullable: true,
    valueFor: urlWith,
  }),
  s('mcp.registryCreate:oauthTokenUrl', mcpRouter.registryCreate, { name: 'n' }, 'oauthTokenUrl', {
    clearable: true,
    nullable: true,
    valueFor: urlWith,
  }),
  s('mcp.registryCreate:oauthRevocationUrl', mcpRouter.registryCreate, { name: 'n' }, 'oauthRevocationUrl', {
    clearable: true,
    nullable: true,
    valueFor: urlWith,
  }),
  s('mcp.registryUpdate:url', mcpRouter.registryUpdate, { id: 'x' }, 'url', {
    clearable: true,
    nullable: true,
    valueFor: urlWith,
  }),
  s('mcp.registryUpdate:oauthAuthorizeUrl', mcpRouter.registryUpdate, { id: 'x' }, 'oauthAuthorizeUrl', {
    clearable: true,
    nullable: true,
    valueFor: urlWith,
  }),
  s('mcp.registryUpdate:oauthTokenUrl', mcpRouter.registryUpdate, { id: 'x' }, 'oauthTokenUrl', {
    clearable: true,
    nullable: true,
    valueFor: urlWith,
  }),
  s('mcp.registryUpdate:oauthRevocationUrl', mcpRouter.registryUpdate, { id: 'x' }, 'oauthRevocationUrl', {
    clearable: true,
    nullable: true,
    valueFor: urlWith,
  }),

  // ---- model providers ----
  s('providers.save:label', providersRouter.save, providerBase(), 'label', { cap: 64 }),
  s('providers.save:baseUrl', providersRouter.save, { label: 'L', endpoints: ['OPENAI-COMPLETIONS'] }, 'baseUrl', {
    valueFor: urlWith,
  }),
  s('providers.save:notes', providersRouter.save, providerBase(), 'notes', { cap: 500, clearable: true }),
  s('providers.save:extraHeaders key', providersRouter.save, providerBase(), 'extraHeaders key', {
    inputKey: 'extraHeaders',
    valueFor: (v) => ({ [v]: 'v' }),
  }),
  s('providers.save:extraHeaders value', providersRouter.save, providerBase(), 'extraHeaders value', {
    inputKey: 'extraHeaders',
    cap: 500,
    valueFor: (v) => ({ k: v }),
  }),

  // ---- environments ----
  s('environments.create:name', environmentsRouter.create, envBase(), 'name', { cap: 64 }),
  s('environments.update:name', environmentsRouter.update, { id: 'x', ...envBase() }, 'name', {
    cap: 64,
    clearable: true,
  }),
  s('environments.listPaged:q', environmentsRouter.listPaged, { q: 'a' }, 'q', { clearable: true }),

  // ---- settings free text ----
  s('settings.update:companyName', settingsRouter.update, { companyName: 'C' }, 'companyName', {
    cap: 60,
    clearable: true,
  }),
  s('settings.update:companyPrompt', settingsRouter.update, { companyPrompt: 'p' }, 'companyPrompt', {
    cap: 8000,
    clearable: true,
  }),

  // ---- employees list filter (#377 changed the surface, #382 sweeps the filters) ----
  s('employees.listPaged:q', employeesRouter.listPaged, { q: 'a' }, 'q', { clearable: true }),
];

function providerBase() {
  return { label: 'L', baseUrl: 'https://provider.test', endpoints: ['OPENAI-COMPLETIONS'] };
}

const routers: Record<string, unknown> = {
  tasks: tasksRouter,
  projects: projectsRouter,
  statuses: statusesRouter,
  vault: vaultRouter,
  mcp: mcpRouter,
  providers: providersRouter,
  environments: environmentsRouter,
  settings: settingsRouter,
  employees: employeesRouter,
};

/** 'tasks.note:body' → tasksRouter.note, 'vault.secrets.create:name' → vaultRouter.secrets.create */
function procedureForLabel(label: string): unknown {
  const [path] = label.split(':');
  const [root, ...rest] = path.split('.');
  let node: unknown = routers[root];
  for (const part of rest) node = (node as Record<string, unknown>)[part];
  return node;
}

/** a URL whose PATH carries the payload — the scheme check must still pass */
function urlWith(value: string) {
  return `http://provider.test/${value}`;
}

function envBase() {
  return { name: 'n', host: 'host.test', port: '22', username: 'u' };
}

type Refusal = { code?: string; data?: { issues?: { path?: (string | number)[]; message?: string }[] } };

async function refusal(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    await run();
  } catch (error) {
    return error as Refusal;
  }
  throw new Error('the call resolved — an unstorable value was accepted');
}

describe('every raw text write refuses unstorable text (handler-level, #382)', () => {
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
        expect(messages.join(' | ')).toContain(
          `${surface.field} contains invalid characters (NUL or a lone surrogate)`,
        );
      }
    });
  }
});

describe('the surface table is unique and complete (#382 r3)', () => {
  it('every label appears exactly once (a duplicated row is a silently dropped surface)', () => {
    expect(new Set(surfaces.map((surface) => surface.surface)).size).toBe(surfaces.length);
  });

  it('the table covers every guarded surface — bump the count when you add one', () => {
    // 62 surfaces: 14 tasks + 6 projects + 1 status + 9 vault + 18 mcp + 4 providers
    // + 3 environments + 2 settings + 1 employees + 4 URL columns added in r1
    expect(surfaces).toHaveLength(62);
  });
});

describe('the surface table points at the procedure its label names (#382 r2)', () => {
  for (const surface of surfaces) {
    it(`${surface.surface}: label and procedure agree`, () => {
      // a copy-paste slip onto a same-shaped sibling (note -> answer) would
      // otherwise leave the swapped-out procedure unpinned while staying green
      expect(procedureForLabel(surface.surface)).toBe(surface.procedure);
    });
  }
});

describe('the wired schema keeps its own contract (#382: accept / clear / cap)', () => {
  for (const surface of surfaces) {
    const schema = () => schemaOf(surface.procedure);

    it(`${surface.surface}: a well-formed astral pair stays accepted`, () => {
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
      it(`${surface.surface}: the omitted clear path stays open`, () => {
        const key = surface.inputKey ?? surface.field;
        const cleared = { ...surface.base };
        delete cleared[key];
        const parsed = schema().safeParse(cleared);
        expect(parsed.success).toBe(true);
        // success alone is not enough: a `.optional()` -> `.default(x)` swap keeps
        // the parse green while rewriting the stored value on every partial update
        const data = (parsed as { data: Record<string, unknown> }).data;
        if (surface.omittedDefault !== undefined) expect(data[key]).toBe(surface.omittedDefault);
        else expect(Object.prototype.hasOwnProperty.call(data, key)).toBe(false);
      });
    }

    if (surface.nullable) {
      it(`${surface.surface}: the explicit null clear path stays open`, () => {
        // a literal null — building it through valueFor would send a valid URL
        // and leave `.nullable()` -> `.optional()` regressions invisible
        const key = surface.inputKey ?? surface.field;
        const parsed = schema().safeParse({ ...surface.base, [key]: null });
        expect(parsed.success).toBe(true);
        expect((parsed as { data: Record<string, unknown> }).data[key]).toBeNull();
      });
    }
  }
});

describe('vault last-four hint (#382 review): a legal astral secret never corrupts its own hint', () => {
  it('slices by code points — the hint can never carry a lone surrogate', () => {
    // 9 characters: a raw UTF-16 slice(-4) would start on the low half of the pair
    expect(lastFourHint('12345😀abc')).toBe('😀abc');
    // the short-secret rule counts CHARACTERS, not UTF-16 units — five astral
    // characters must get no hint even though they are ten code units
    expect(lastFourHint('😀😀😀😀a')).toBe('');
    expect(lastFourHint('12345678')).toBe('');
    expect(lastFourHint('123456789')).toBe('6789');
  });
});
