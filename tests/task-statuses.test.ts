import { eq } from 'drizzle-orm';
// task statuses: CRUD + transition enforcement on tasks
import { beforeEach, describe, expect, it } from 'vitest';

import './api-harness';
import { applyMigrations } from '../server/db/index';
import { OBLIGATION_STATUS, ROLE } from '../shared/enums';
import { STATUS } from '../shared/status';
import type { TaskStatusRow } from '../shared/types';
import { resetSchema } from './helpers/pg';

async function wireDecisionProvider(secretId: string | null) {
  const d = await dbm();
  const { modelProviders } = await import('../server/db/schema');
  await d.db
    .insert(modelProviders)
    .values({
      id: 'seed-jev',
      label: 'Jev (TypeSafe AI)',
      baseUrl: 'https://api.typesafe.ai',
      endpoints: ['TYPESAFE-SYSTEMONE'],
    })
    .onConflictDoUpdate({ target: modelProviders.id, set: { endpoints: ['TYPESAFE-SYSTEMONE'] } });
  await wireInternalDecisionSetting(secretId);
}

async function wireInternalDecisionSetting(secretId: string | null) {
  const { setSetting } = await import('../server/domains/settings/settings.service');
  if (secretId) {
    await setSetting(
      'internal_decision',
      JSON.stringify({ providerId: 'seed-jev', model: 'jev-latest', keySecretId: secretId }),
    );
  } else {
    const { deleteSetting } = await import('../server/domains/settings/settings.service');
    await deleteSetting('internal_decision');
  }
}

const admin = {
  id: '00000000-0000-7000-8000-cd5fca5e2d34',
  name: 'Admin',
  email: 'admin@tandem.local',
  role: ROLE.ADMIN,
};

async function ctx() {
  const { buildServerContext } = await import('../server/domains/kernel/context');
  const context = buildServerContext(new Headers()) as Record<string, unknown>;
  (context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => ({ user: admin });
  context.session = { user: admin };
  return context;
}

async function dbm() {
  return await import('../server/db');
}

async function callProc(path: string, input?: unknown): Promise<any> {
  const { appRouter: router } = await import('../server/domains/app.router');
  let node: Record<string, unknown> = router as unknown as Record<string, unknown>;
  for (const key of path.split('.')) node = node[key] as Record<string, unknown>;
  const internals = node['~orpc'] as { handler: (opts: unknown) => Promise<unknown> };
  return await internals.handler({ input, context: await ctx(), signal: new AbortController().signal });
}

beforeEach(async () => {
  await resetSchema();
  await applyMigrations();
  const { db } = await import('../server/db');
  const { user } = await import('../server/db/schema');
  await db
    .insert(user)
    .values({ id: admin.id, name: 'Admin', email: 'admin@tandem.local', role: ROLE.ADMIN, title: 'T' });
});

describe('task statuses', () => {
  it('live returns seeded statuses ordered with transitions', async () => {
    const iter = await callProc('statuses.live');
    const snap = (await iter.next()).value as { status?: string };
    const rows = snap.status === OBLIGATION_STATUS.PENDING ? (await iter.next()).value : snap;
    const list = (Array.isArray(rows) ? rows : ((rows as { rows?: TaskStatusRow[] }).rows ?? rows)) as TaskStatusRow[];
    const ids = list.map((x) => x.id);
    expect(ids).toEqual([
      STATUS.todo,
      STATUS.doing,
      STATUS.done,
      STATUS.waitingAnswer,
      STATUS.inReview,
      STATUS.blocked,
      STATUS.cancelled,
    ]);
    expect(list.find((x) => x.id === STATUS.doing)!.nextIds).toContain(STATUS.done);
    expect(list.find((x) => x.id === STATUS.todo)!.category).toBe('ready');
  });

  it('save creates a status with transitions; unknown transition rejected', async () => {
    const r = await callProc('statuses.save', {
      name: 'In review',
      color: 'warning',
      position: 2,
      category: 'working',
      nextIds: [STATUS.done],
    });
    expect(r.id).toBeTruthy();
    await expect(
      callProc('statuses.save', { name: 'Bad', color: 'neutral', position: 5, isDone: false, nextIds: ['ghost'] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('save upserts by id (rename)', async () => {
    const r = await callProc('statuses.save', {
      id: STATUS.todo,
      name: 'Backlog',
      color: 'neutral',
      position: 0,
      category: 'ready',
      nextIds: [STATUS.doing],
    });
    expect(r.id).toBe(STATUS.todo);
    const { db } = await dbm();
    const { taskStatuses } = await import('../server/db/schema');
    const row = (await db.select().from(taskStatuses)).find((x) => x.id === STATUS.todo)!;
    expect(row.name).toBe('Backlog');
  });

  it('remove blocked while a task uses the status', async () => {
    const t = await callProc('tasks.create', { title: 'T1' });
    await expect(callProc('statuses.remove', { id: STATUS.todo })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await callProc('tasks.remove', { id: t.id });
    await expect(callProc('statuses.remove', { id: STATUS.todo })).resolves.toMatchObject({ ok: true });
  });

  it('save rejects reserved id "new"', async () => {
    await expect(
      callProc('statuses.save', { id: 'new', name: 'N', color: 'neutral', position: 9, isDone: false, nextIds: [] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('create with no statuses defined fails clearly', async () => {
    // remove all seeded statuses (no tasks exist)
    for (const id of [
      STATUS.todo,
      STATUS.doing,
      STATUS.done,
      STATUS.waitingAnswer,
      STATUS.inReview,
      STATUS.blocked,
      STATUS.cancelled,
    ])
      await callProc('statuses.remove', { id });
    await expect(callProc('tasks.create', { title: 'NoStatus' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: /no task statuses/i,
    });
  });

  it('remove unknown 404s', async () => {
    await expect(callProc('statuses.remove', { id: 'ghost' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('tasks.create validates status; default = first status', async () => {
    const t = await callProc('tasks.create', { title: 'A' });
    const { db } = await dbm();
    const { tasks } = await import('../server/db/schema');
    const row = (await db.select().from(tasks)).find((x) => x.id === t.id)!;
    expect(row.status).toBe(STATUS.todo);
    await expect(callProc('tasks.create', { title: 'B', status: 'ghost' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    const t2 = await callProc('tasks.create', { title: 'C', status: STATUS.doing });
    const row2 = (await db.select().from(tasks)).find((x) => x.id === t2.id)!;
    expect(row2.status).toBe(STATUS.doing);
  });

  it('tasks.update enforces transitions (todo -> done blocked, todo -> doing ok)', async () => {
    const t = await callProc('tasks.create', { title: 'X' });
    await expect(callProc('tasks.update', { id: t.id, status: STATUS.done })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: /cannot move/i,
    });
    await callProc('tasks.update', { id: t.id, status: STATUS.doing });
    await callProc('tasks.update', { id: t.id, status: STATUS.done });
    await expect(callProc('tasks.update', { id: t.id, status: 'ghost' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: /does not exist/i,
    });
  });

  it('tasks.update same-status is a no-op pass', async () => {
    const t = await callProc('tasks.create', { title: 'Y' });
    await expect(callProc('tasks.update', { id: t.id, status: STATUS.todo })).resolves.toMatchObject({ ok: true });
  });
});

describe('jev auto-assign', () => {
  it('assign: no decision provider at all -> clear reason', async () => {
    const d = await dbm();
    const { modelProviders } = await import('../server/db/schema');
    await d.db.delete(modelProviders);
    const t = await callProc('tasks.create', { title: 'NoProvider' });
    const r = await callProc('statuses.assign', { taskId: t.id });
    expect(r.assigned).toBe(false);
    expect(r.reason).toBe('no decision provider configured');
    // restore provider seeds for any later reader (parallel files share the DB)
    await d.db
      .insert(modelProviders)
      .values({
        id: 'seed-jev',
        label: 'Jev (TypeSafe AI)',
        baseUrl: 'https://api.typesafe.ai',
        endpoints: ['TYPESAFE-SYSTEMONE'],
      })
      .onConflictDoNothing();
  });

  it('assign: no key secret passed -> assigned false with reason', async () => {
    // no key secret WIRED (provider exists, setting has no keySecretId) -> assign refuses
    const d = await dbm();
    const { modelProviders } = await import('../server/db/schema');
    await d.db
      .insert(modelProviders)
      .values({
        id: 'seed-jev',
        label: 'Jev (TypeSafe AI)',
        baseUrl: 'https://api.typesafe.ai',
        endpoints: ['TYPESAFE-SYSTEMONE'],
      })
      .onConflictDoNothing();
    const { setSetting } = await import('../server/domains/settings/settings.service');
    await setSetting(
      'internal_decision',
      JSON.stringify({ providerId: 'seed-jev', model: 'jev-latest', keySecretId: null }),
    );
    const t = await callProc('tasks.create', { title: 'Jev task' });
    const r = await callProc('statuses.assign', { taskId: t.id });
    expect(r.assigned).toBe(false);
    expect(r.reason).toBe('no api key secret provided');
  });

  it('assign: null model in a legacy stored assignment degrades to not-configured', async () => {
    const d = await dbm();
    const { modelProviders, vaultSecrets } = await import('../server/db/schema');
    const { setSetting } = await import('../server/domains/settings/settings.service');
    const secId = 'sec-default-arm';
    await d.db
      .insert(vaultSecrets)
      .values({ id: secId, name: 'k', description: '', ciphertext: '', lastFour: '', createdBy: admin.id })
      .onConflictDoNothing();
    await d.db
      .insert(modelProviders)
      .values({
        id: 'seed-jev',
        label: 'Jev (TypeSafe AI)',
        baseUrl: 'https://def.example.com',
        endpoints: ['TYPESAFE-SYSTEMONE'],
      })
      .onConflictDoUpdate({ target: modelProviders.id, set: { endpoints: ['TYPESAFE-SYSTEMONE'] } });
    await setSetting('internal_decision', JSON.stringify({ providerId: 'seed-jev', model: null, keySecretId: secId }));
    const t = await callProc('tasks.create', { title: 'Default model task' });
    const r = await callProc('statuses.assign', { taskId: t.id });
    expect(r.assigned).toBe(false);
  });

  it('assign: with mocked jev response assigns the chosen employee', async () => {
    // create a vault secret as the jev key holder
    const sec = await callProc('vault.secrets.create', { name: 'jev-key', value: 'sk-jev-test' });
    await wireDecisionProvider(sec.id);
    // an employee candidate
    const emp = await callProc('employees.create', {
      name: 'Jev Bot',
      email: 'jevbot@tandem.local',
      kind: 'human',
      title: 'Runner',
      supervisorIds: [],
    });
    const t = await callProc('tasks.create', { title: 'Write the docs' });

    const origFetch = globalThis.fetch;
    let called = 0;
    let seenBody = '';
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      called++;
      seenBody = String((init as { body?: string })?.body ?? '');
      const target = (url as string).includes('typesafe.ai');
      if (target) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: 'jev-test',
            answers: {
              assignee: { type: 'choice', choice: emp.id, confidence: 0.9, probabilities: { [emp.id]: 0.9 } },
            },
          }),
        };
      }
      return origFetch(url as RequestInfo | URL, init as RequestInit);
    }) as typeof fetch;
    try {
      const r = await callProc('statuses.assign', { taskId: t.id });
      expect(r.assigned).toBe(true);
      expect(r.employeeId).toBe(emp.id);
      expect(called).toBe(1);
      expect(seenBody).toContain('Write the docs');
      // task updated
      const { db } = await dbm();
      const { tasks } = await import('../server/db/schema');
      const row = (await db.select().from(tasks)).find((x) => x.id === t.id)!;
      expect(row.assigneeId).toBe(emp.id);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('assign: low confidence leaves task unassigned', async () => {
    const sec = await callProc('vault.secrets.create', { name: 'jev-key2', value: 'sk-jev-test2' });
    await wireDecisionProvider(sec.id);
    const t = await callProc('tasks.create', { title: 'Unclear task' });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'jev-test',
        answers: {
          assignee: { type: 'choice', choice: 'unassigned', confidence: 0.9, probabilities: { unassigned: 0.9 } },
        },
      }),
    })) as typeof fetch;
    try {
      const r = await callProc('statuses.assign', { taskId: t.id });
      expect(r.assigned).toBe(false);
      expect(r.reason).toMatch(/unassigned/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('assign: jev failure arms (http error, no choice, unknown id, network throw)', async () => {
    const sec = await callProc('vault.secrets.create', { name: 'jev-key3', value: 'sk-jev-3' });
    await wireDecisionProvider(sec.id);
    const t = await callProc('tasks.create', { title: 'Arms' });
    const origFetch = globalThis.fetch;
    // http error
    globalThis.fetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as typeof fetch;
    let r = await callProc('statuses.assign', { taskId: t.id });
    expect(r.assigned).toBe(false);
    expect(r.reason).toMatch(/401/);
    // no choice
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ model: 'm', answers: {} }),
    })) as typeof fetch;
    r = await callProc('statuses.assign', { taskId: t.id });
    expect(r.assigned).toBe(false);
    expect(r.reason).toMatch(/no choice/);
    // unknown employee id
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'm',
        answers: { assignee: { type: 'choice', choice: 'ghost-emp', confidence: 0.9, probabilities: {} } },
      }),
    })) as typeof fetch;
    r = await callProc('statuses.assign', { taskId: t.id });
    expect(r.assigned).toBe(false);
    expect(r.reason).toMatch(/unknown employee/);
    // low confidence (valid candidate id below 0.5)
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'm',
        answers: {
          assignee: {
            type: 'choice',
            choice: '00000000-0000-7000-8000-cd5fca5e2d34',
            confidence: 0.3,
            probabilities: {},
          },
        },
      }),
    })) as typeof fetch;
    r = await callProc('statuses.assign', { taskId: t.id });
    expect(r.assigned).toBe(false);
    expect(r.reason).toMatch(/low confidence/);
    // network throw
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    r = await callProc('statuses.assign', { taskId: t.id });
    expect(r.assigned).toBe(false);
    expect(r.reason).toMatch(/could not reach/);
    globalThis.fetch = origFetch;
  });

  it('assign: empty candidate list + assigned-task load counting', async () => {
    // create task first (created_by FK), then delete all users -> zero candidates
    const t1 = await callProc('tasks.create', { title: 'NoCandidates' });
    const { db } = await dbm();
    const { user } = await import('../server/db/schema');
    await db.delete(user);
    const r = await callProc('statuses.assign', { taskId: t1.id });
    expect(r.assigned).toBe(false);
    expect(r.reason).toMatch(/no assignee candidates/);
  });

  it('assign: candidate state string includes title/load/description arms', async () => {
    const sec = await callProc('vault.secrets.create', { name: 'jev-key4', value: 'sk-jev-4' });
    await wireDecisionProvider(sec.id);
    // AI employee with a title + open task load; human without title
    const d = await dbm();
    const { environments } = await import('../server/db/schema');
    await d.db.insert(environments).values({
      id: 'env-jev',
      name: 'env-jev',
      host: '127.0.0.1',
      port: '22',
      username: '00000000-0000-7000-8000-51e69892ab49',
    });
    const ai = await callProc('employees.create', {
      name: 'Titled Bot',
      email: 'tb@tandem.local',
      kind: 'ai',
      title: 'Writer',
      environmentId: 'env-jev',
      executable: 'hermes acp',
    });
    const loaded = await callProc('tasks.create', { title: 'Load carrier' });
    await callProc('tasks.update', { id: loaded.id, assigneeId: ai.id });
    const t = await callProc('tasks.create', { title: 'Rich task', description: 'with description' });
    const origFetch = globalThis.fetch;
    let state = '';
    let criteria = '';
    globalThis.fetch = (async (_u: unknown, init?: unknown) => {
      const body = JSON.parse(String((init as { body?: string })?.body ?? '{}'));
      state = body.state;
      criteria = JSON.stringify(body.questions.assignee.criteria);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'jev-test',
          answers: { assignee: { type: 'choice', choice: ai.id, confidence: 0.8, probabilities: {} } },
        }),
      };
    }) as typeof fetch;
    try {
      const r = await callProc('statuses.assign', { taskId: t.id });
      expect(r.assigned).toBe(true);
      expect(state).toContain('with description');
      expect(state).toContain('1 open tasks');
      expect(criteria).toContain('AI agent — Titled Bot, Writer, currently 1 open task(s)');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('assign: minimal jev answer (no confidence/probabilities) still assigns', async () => {
    const sec = await callProc('vault.secrets.create', { name: 'jev-key5', value: 'sk-jev-5' });
    await wireDecisionProvider(sec.id);
    const t = await callProc('tasks.create', { title: 'Minimal' });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'jev-test',
        answers: { assignee: { type: 'choice', choice: '00000000-0000-7000-8000-cd5fca5e2d34' } },
      }),
    })) as typeof fetch;
    try {
      const r = await callProc('statuses.assign', { taskId: t.id });
      expect(r.assigned).toBe(false); // confidence defaults to 0 -> low confidence arm
      expect(r.reason).toMatch(/low confidence 0.00/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('assign: untitled AI candidate + task with project covers remaining arms', async () => {
    const sec = await callProc('vault.secrets.create', { name: 'jev-key6', value: 'sk-jev-6' });
    await wireDecisionProvider(sec.id);
    const d = await dbm();
    const { environments } = await import('../server/db/schema');
    await d.db.insert(environments).values({
      id: 'env-j2',
      name: 'env-j2',
      host: '127.0.0.1',
      port: '22',
      username: '00000000-0000-7000-8000-51e69892ab49',
    });
    const ai = await callProc('employees.create', {
      name: 'Plain Bot',
      email: 'pb@tandem.local',
      kind: 'ai',
      title: 'Writer',
      environmentId: 'env-j2',
      executable: 'hermes acp',
    });
    // null the title on the user row (candidates map reads user.title)
    const { user } = await import('../server/db/schema');
    await d.db.update(user).set({ title: null }).where(eq(user.id, ai.id));
    const proj = await callProc('projects.create', { name: 'JevProj' });
    const t = await callProc('tasks.create', { title: 'Proj task', projectId: proj.id });
    const origFetch = globalThis.fetch;
    let state = '';
    globalThis.fetch = (async (_u: unknown, init?: unknown) => {
      state = JSON.parse(String((init as { body?: string })?.body ?? '{}')).state;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'jev-test',
          answers: { assignee: { type: 'choice', choice: ai.id, confidence: 0.9, probabilities: {} } },
        }),
      };
    }) as typeof fetch;
    try {
      const r = await callProc('statuses.assign', { taskId: t.id });
      expect(r.assigned).toBe(true);
      expect(state).toContain('Project: JevProj');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('assign: dangling secret id + deleted project name arms', async () => {
    await wireDecisionProvider('ghost-secret');
    const proj = await callProc('projects.create', { name: 'GhostProj' });
    const t = await callProc('tasks.create', { title: 'GhostProj task', projectId: proj.id });
    // delete the project row directly -> task.projectId dangles (set null by FK in real flow; simulate)
    const d = await dbm();
    const { projects } = await import('../server/db/schema');
    await d.db.delete(projects).where(eq(projects.id, proj.id));
    // ghost secret id -> provider exists but key undecryptable/missing
    const r = await callProc('statuses.assign', { taskId: t.id });
    expect(r.assigned).toBe(false);
    expect(r.reason).toMatch(/no api key/);
  });

  it('assign: unassigned choice with probabilities present', async () => {
    const sec = await callProc('vault.secrets.create', { name: 'jev-key7', value: 'sk-jev-7' });
    await wireDecisionProvider(sec.id);
    const t = await callProc('tasks.create', { title: 'Unassign me' });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'jev-test',
        answers: {
          assignee: {
            type: 'choice',
            choice: 'unassigned',
            confidence: 0.8,
            probabilities: { unassigned: 0.8, '00000000-0000-7000-8000-cd5fca5e2d34': 0.2 },
          },
        },
      }),
    })) as typeof fetch;
    try {
      const r = await callProc('statuses.assign', { taskId: t.id });
      expect(r.assigned).toBe(false);
      expect(r.reason).toBe('decision model chose unassigned');
      expect(r.confidence).toBe(0.8);
      expect(r.probabilities).toMatchObject({ unassigned: 0.8 });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('assign: low-confidence choice with probabilities + missing model', async () => {
    const sec = await callProc('vault.secrets.create', { name: 'jev-key8', value: 'sk-jev-8' });
    await wireDecisionProvider(sec.id);
    const t = await callProc('tasks.create', { title: 'Lowconf' });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        answers: {
          assignee: {
            type: 'choice',
            choice: '00000000-0000-7000-8000-cd5fca5e2d34',
            confidence: 0.2,
            probabilities: { '00000000-0000-7000-8000-cd5fca5e2d34': 0.2 },
          },
        },
      }),
    })) as typeof fetch;
    try {
      const r = await callProc('statuses.assign', { taskId: t.id });
      expect(r.assigned).toBe(false);
      expect(r.reason).toMatch(/low confidence 0.20/);
      expect(r.probabilities).toMatchObject({ '00000000-0000-7000-8000-cd5fca5e2d34': 0.2 });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('assign: no-choice response without model falls back to unknown', async () => {
    const sec = await callProc('vault.secrets.create', { name: 'jev-key9', value: 'sk-jev-9' });
    await wireDecisionProvider(sec.id);
    const t = await callProc('tasks.create', { title: 'NoModel' });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ answers: {} }) })) as typeof fetch;
    try {
      const r = await callProc('statuses.assign', { taskId: t.id });
      expect(r.assigned).toBe(false);
      expect(r.reason).toBe('no choice in answer');
      expect(r.model).toBe('unknown');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('assign: task with dangling project id yields no project name', async () => {
    const sec = await callProc('vault.secrets.create', { name: 'jev-keyA', value: 'sk-jev-A' });
    await wireDecisionProvider(sec.id);
    const t = await callProc('tasks.create', { title: 'Ghost proj' });
    // simulate a dangling project reference (FK normally prevents it; guards the lookup)
    const d = await dbm();
    const { tasks } = await import('../server/db/schema');
    await d.db.execute('ALTER TABLE tasks DROP CONSTRAINT tandem_tasks_project_id_tandem_projects_id_fkey');
    await d.db.update(tasks).set({ projectId: 'ghost-proj' }).where(eq(tasks.id, t.id));
    const origFetch = globalThis.fetch;
    let state = '';
    globalThis.fetch = (async (_u: unknown, init?: unknown) => {
      state = JSON.parse(String((init as { body?: string })?.body ?? '{}')).state;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'm',
          answers: {
            assignee: {
              type: 'choice',
              choice: '00000000-0000-7000-8000-cd5fca5e2d34',
              confidence: 0.9,
              probabilities: {},
            },
          },
        }),
      };
    }) as typeof fetch;
    try {
      const r = await callProc('statuses.assign', { taskId: t.id });
      expect(r.assigned).toBe(true);
      expect(state).not.toContain('Project:');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('assign: OPENAI-DECISIONS style routes to the /decisions adapter (array answers)', async () => {
    const sec = await callProc('vault.secrets.create', { name: 'jev-keyOA', value: 'sk-jev-OA' });
    const d = await dbm();
    const { modelProviders } = await import('../server/db/schema');
    await d.db
      .insert(modelProviders)
      .values({
        id: 'seed-jev',
        label: 'Jev (TypeSafe AI)',
        baseUrl: 'https://oa.example.com',
        endpoints: ['OPENAI-DECISIONS'],
      })
      .onConflictDoUpdate({
        target: modelProviders.id,
        set: { baseUrl: 'https://oa.example.com', endpoints: ['OPENAI-DECISIONS'] },
      });
    await wireInternalDecisionSetting(sec.id);
    const t = await callProc('tasks.create', { title: 'OA decision task' });
    const origFetch = globalThis.fetch;
    let hitUrl = '';
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (u: unknown, init?: unknown) => {
      hitUrl = String(u);
      body = JSON.parse(String((init as { body?: string })?.body ?? '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'gpt-6-luna',
          answers: [
            {
              name: 'assignee',
              type: 'choice',
              choice: '00000000-0000-7000-8000-cd5fca5e2d34',
              confidence: 0.9,
              probabilities: [{ value: '00000000-0000-7000-8000-cd5fca5e2d34', probability: 0.9 }],
            },
          ],
        }),
      };
    }) as typeof fetch;
    try {
      const r = await callProc('statuses.assign', { taskId: t.id });
      expect(r.assigned).toBe(true);
      expect(hitUrl).toBe('https://oa.example.com/v1/decisions');
      expect(Array.isArray(body.questions)).toBe(true);
      expect(body.input).toContain('OA decision task');
      expect(r.confidence).toBe(0.9);
      expect(r.probabilities).toEqual({ '00000000-0000-7000-8000-cd5fca5e2d34': 0.9 });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('assign: OPENAI-DECISIONS failure arms (http error, no matching name)', async () => {
    const sec = await callProc('vault.secrets.create', { name: 'jev-keyOB', value: 'sk-jev-OB' });
    const d = await dbm();
    const { modelProviders } = await import('../server/db/schema');
    await d.db
      .insert(modelProviders)
      .values({
        id: 'seed-jev',
        label: 'Jev (TypeSafe AI)',
        baseUrl: 'https://ob.example.com',
        endpoints: ['OPENAI-DECISIONS'],
      })
      .onConflictDoUpdate({
        target: modelProviders.id,
        set: { baseUrl: 'https://ob.example.com', endpoints: ['OPENAI-DECISIONS'] },
      });
    await wireInternalDecisionSetting(sec.id);
    const t = await callProc('tasks.create', { title: 'OB arms' });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 429, json: async () => ({}) })) as typeof fetch;
    let r = await callProc('statuses.assign', { taskId: t.id });
    expect(r.assigned).toBe(false);
    expect(r.reason).toMatch(/429/);
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ model: 'gpt-6-luna', answers: [{ name: 'other', type: 'choice', choice: 'x' }] }),
    })) as typeof fetch;
    r = await callProc('statuses.assign', { taskId: t.id });
    expect(r.assigned).toBe(false);
    expect(r.reason).toBe('no choice in answer');
    globalThis.fetch = origFetch;
  });

  it('assign: OPENAI-DECISIONS url/answer edge arms (trailing slash, no confidence/probs)', async () => {
    const sec = await callProc('vault.secrets.create', { name: 'jev-keyOC', value: 'sk-jev-OC' });
    const d = await dbm();
    const { modelProviders } = await import('../server/db/schema');
    // baseUrl already ending in /decisions AND with trailing slash
    await d.db
      .insert(modelProviders)
      .values({
        id: 'seed-jev',
        label: 'Jev (TypeSafe AI)',
        baseUrl: 'https://oc.example.com/v1/decisions/',
        endpoints: ['OPENAI-DECISIONS'],
      })
      .onConflictDoUpdate({
        target: modelProviders.id,
        set: { baseUrl: 'https://oc.example.com/v1/decisions/', endpoints: ['OPENAI-DECISIONS'] },
      });
    await wireInternalDecisionSetting(sec.id);
    const t = await callProc('tasks.create', { title: 'OC edges' });
    const origFetch = globalThis.fetch;
    let hitUrl = '';
    globalThis.fetch = (async (u: unknown) => {
      hitUrl = String(u);
      // answer without confidence and without probabilities; choice is a string
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'gpt-6-luna',
          answers: [{ name: 'assignee', type: 'choice', choice: '00000000-0000-7000-8000-cd5fca5e2d34' }],
        }),
      };
    }) as typeof fetch;
    try {
      const r = await callProc('statuses.assign', { taskId: t.id });
      // trailing slash stripped, no double /decisions
      expect(hitUrl).toBe('https://oc.example.com/v1/decisions');
      expect(r.assigned).toBe(false); // confidence defaults 0 -> low confidence arm
      expect(r.reason).toMatch(/low confidence 0.00/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('assign: OPENAI-DECISIONS no-model + boolean probability values arms', async () => {
    const sec = await callProc('vault.secrets.create', { name: 'jev-keyOD', value: 'sk-jev-OD' });
    const d = await dbm();
    const { modelProviders } = await import('../server/db/schema');
    await d.db
      .insert(modelProviders)
      .values({
        id: 'seed-jev',
        label: 'Jev (TypeSafe AI)',
        baseUrl: 'https://od.example.com',
        endpoints: ['OPENAI-DECISIONS'],
      })
      .onConflictDoUpdate({
        target: modelProviders.id,
        set: { baseUrl: 'https://od.example.com', endpoints: ['OPENAI-DECISIONS'] },
      });
    await wireInternalDecisionSetting(sec.id);
    const t = await callProc('tasks.create', { title: 'OD arms' });
    const origFetch = globalThis.fetch;
    // no-choice without model -> 'unknown' model; plus boolean-valued probability entries skipped
    // no matching answer name -> no-choice arm, model falls back to 'unknown'
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ answers: [{ name: 'other', type: 'choice', choice: 'x' }] }),
    })) as typeof fetch;
    let r = await callProc('statuses.assign', { taskId: t.id });
    expect(r.assigned).toBe(false);
    expect(r.reason).toBe('no choice in answer');
    expect(r.model).toBe('unknown');
    // boolean-valued probability entries are skipped; string ones kept
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'gpt-6-luna',
        answers: [
          {
            name: 'assignee',
            type: 'choice',
            choice: 'unassigned',
            confidence: 0.9,
            probabilities: [
              { value: true, probability: 0.1 },
              { value: 'unassigned', probability: 0.9 },
            ],
          },
        ],
      }),
    })) as typeof fetch;
    r = await callProc('statuses.assign', { taskId: t.id });
    expect(r.assigned).toBe(false);
    expect(r.reason).toBe('decision model chose unassigned');
    expect(r.probabilities).toEqual({ unassigned: 0.9 });
    globalThis.fetch = origFetch;
  });

  it('assign: unknown task 404s', async () => {
    await expect(callProc('statuses.assign', { taskId: 'ghost' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
