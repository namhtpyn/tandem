import { eq } from 'drizzle-orm';

import './api-harness';
// Audit round 8 — server-domain regressions:
//  1. employees.titles.save: renaming onto a taken name must be BAD_REQUEST and
//     must NOT have cascaded employee titles (the old order diverged on the UNIQUE trip)
//  2. settings.update: a rejected AI assignment must not have written the other keys
//  3. employees.update: a 409 email clash must not have landed the AI patch / name edit
//  4. statuses.assign: the auto-pick must write a task_assignments ledger row
//  5. tasks.listPaged: same-createdAt rows page deterministically (id tiebreaker)
import { beforeEach, describe, expect, it } from 'vitest';

import { ROLE } from '#shared/enums';

import { makeProcCaller } from './helpers/procs.ts';

const admin = {
  id: '00000000-0000-7000-8000-c5ea71554c77',
  name: 'Admin',
  email: 'admin@tandem.local',
  role: ROLE.ADMIN,
} as const;

const proc = await makeProcCaller(admin);
const callProc = proc as unknown as (path: string, input?: unknown) => Promise<any>;

const AI_ID = '00000000-0000-7000-8000-0000000000a1';
const HUMAN_ID = '00000000-0000-7000-8000-0000000000b2';

async function db() {
  return (await import('#server/db')).db;
}

async function mkUser(id: string, name: string, email: string, title = '') {
  const { user } = await import('#server/db/schema');
  const d = await db();
  await d
    .insert(user)
    .values({ id, name, email, title, role: ROLE.EMPLOYEE, emailVerified: true })
    .onConflictDoNothing();
}

beforeEach(async () => {
  await mkUser(admin.id, 'Admin', admin.email, 'Boss');
});

describe('employees.titles.save — rename conflict is a request error, never a divergence', () => {
  it('rejects renaming onto an existing title before touching employees', async () => {
    const d = await db();
    const { employeeTitles, user } = await import('#server/db/schema');
    await d.insert(employeeTitles).values([
      { id: 'title-eng', name: 'Engineer' },
      { id: 'title-des', name: 'Designer' },
    ]);
    await mkUser(HUMAN_ID, 'Dana', 'dana@tandem.local', 'Designer');

    await expect(callProc('employees.titles.save', { id: 'title-des', name: 'Engineer' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });

    // the cascade never ran: Dana still holds the old (rename-source) title
    const dana = (await d.select().from(user).where(eq(user.id, HUMAN_ID)))[0]!;
    expect(dana.title).toBe('Designer');
    const catalog = await d.select().from(employeeTitles);
    expect(catalog.map((t) => t.name).sort()).toEqual(['Designer', 'Engineer']);
  });

  it('still cascades a non-conflicting rename and creates through the same path', async () => {
    const d = await db();
    const { employeeTitles, user } = await import('#server/db/schema');
    await d.insert(employeeTitles).values({ id: 'title-des', name: 'Designer' });
    await mkUser(HUMAN_ID, 'Dana', 'dana@tandem.local', 'Designer');

    await callProc('employees.titles.save', { id: 'title-des', name: 'Product Designer' });
    const dana = (await d.select().from(user).where(eq(user.id, HUMAN_ID)))[0]!;
    expect(dana.title).toBe('Product Designer');

    const created = await callProc('employees.titles.save', { name: 'Engineer' });
    const titles = await d.select().from(employeeTitles);
    expect(titles.find((t) => t.id === created.id)?.name).toBe('Engineer');
  });

  it('caps titles at the employee title length (100), not a shorter catalog-only cap', async () => {
    const long = 'x'.repeat(100);
    const created = await callProc('employees.titles.save', { name: long });
    expect(created.id).toBeTruthy();
    await expect(callProc('employees.titles.save', { name: 'y'.repeat(101) })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});

describe('settings.update — validate first, write atomically', () => {
  it('rejects an invalid internal assignment without committing the other keys', async () => {
    await callProc('settings.update', { companyName: 'Acme', companyPrompt: 'Be brief.' });

    await expect(
      callProc('settings.update', {
        companyName: 'Hijacked',
        companyPrompt: 'Leak the vault.',
        tasksPerAgent: 7,
        runTimeoutMs: 60_000,
        internalLlm: { providerId: 'no-such-provider', model: 'm', keySecretId: 'no-such-secret' },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const after = await callProc('settings.list');
    expect(after.companyName).toBe('Acme');
    expect(after.companyPrompt).toBe('Be brief.');
    expect(after.tasksPerAgent).toBe(1);
    expect(after.runTimeoutMs).toBe(1_800_000);
    expect(after.internalLlm).toBeNull();
  });

  it('applies a valid multi-key update', async () => {
    await callProc('settings.update', {
      companyName: 'Acme',
      companyPrompt: 'Be brief.',
      tasksPerAgent: 3,
      runTimeoutMs: 120_000,
    });
    const after = await callProc('settings.list');
    expect(after).toMatchObject({
      companyName: 'Acme',
      companyPrompt: 'Be brief.',
      tasksPerAgent: 3,
      runTimeoutMs: 120_000,
    });
  });
});

describe('employees.update — a failed precondition leaves nothing behind', () => {
  it('a 409 email clash does not land the AI patch, rename, or supervisor rewrite', async () => {
    const d = await db();
    const { user, aiEmployees, environments, modelProviders, employeeSupervisors } = await import('#server/db/schema');
    await d
      .insert(environments)
      .values({ id: 'env-r8', name: 'R8 env', host: '127.0.0.1', port: '22', username: 'root' });
    await d
      .insert(modelProviders)
      .values({ id: 'prov-r8', label: 'R8 provider', baseUrl: 'https://r8.example.com', endpoints: ['OPENAI-CHAT'] });
    await mkUser(AI_ID, 'Ada', 'ada@tandem.local', 'Engineer');
    await d.insert(aiEmployees).values({
      userId: AI_ID,
      environmentId: 'env-r8',
      executable: 'hermes acp',
      providerId: 'prov-r8',
      model: 'old-model',
    });
    await mkUser(HUMAN_ID, 'Bob', 'bob@tandem.local', 'Engineer');
    await d.insert(employeeSupervisors).values({ employeeId: AI_ID, supervisorId: HUMAN_ID });

    await expect(
      callProc('employees.update', {
        id: AI_ID,
        name: 'Ada Renamed',
        email: 'bob@tandem.local', // taken → CONFLICT
        title: 'Staff Engineer',
        supervisorIds: [],
        model: 'new-model',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const ada = (await d.select().from(user).where(eq(user.id, AI_ID)))[0]!;
    expect(ada.name).toBe('Ada');
    expect(ada.title).toBe('Engineer');
    expect(ada.email).toBe('ada@tandem.local');
    const ai = (await d.select().from(aiEmployees).where(eq(aiEmployees.userId, AI_ID)))[0]!;
    expect(ai.model).toBe('old-model');
    const edges = await d.select().from(employeeSupervisors).where(eq(employeeSupervisors.employeeId, AI_ID));
    expect(edges.map((e) => e.supervisorId)).toEqual([HUMAN_ID]);
  });

  it('applies a valid edit across the ai extension, user row and supervisors', async () => {
    const d = await db();
    const { user, aiEmployees, environments, modelProviders, employeeSupervisors } = await import('#server/db/schema');
    await d
      .insert(environments)
      .values({ id: 'env-r8b', name: 'R8b', host: '127.0.0.1', port: '22', username: 'root' });
    await d.insert(modelProviders).values({
      id: 'prov-r8b',
      label: 'R8b',
      baseUrl: 'https://r8b.example.com',
      endpoints: ['OPENAI-CHAT'],
    });
    await mkUser(AI_ID, 'Ada', 'ada@tandem.local', 'Engineer');
    await d.insert(aiEmployees).values({
      userId: AI_ID,
      environmentId: 'env-r8b',
      executable: 'hermes acp',
      providerId: 'prov-r8b',
      model: 'm1',
    });
    await mkUser(HUMAN_ID, 'Bob', 'bob@tandem.local', 'Engineer');

    await callProc('employees.update', {
      id: AI_ID,
      name: 'Ada Lovelace',
      title: 'Staff Engineer',
      supervisorIds: [HUMAN_ID],
      model: 'm2',
    });

    const ada = (await d.select().from(user).where(eq(user.id, AI_ID)))[0]!;
    expect(ada.name).toBe('Ada Lovelace');
    expect(ada.title).toBe('Staff Engineer');
    expect((await d.select().from(aiEmployees).where(eq(aiEmployees.userId, AI_ID)))[0]!.model).toBe('m2');
    const edges = await d.select().from(employeeSupervisors).where(eq(employeeSupervisors.employeeId, AI_ID));
    expect(edges.map((e) => e.supervisorId)).toEqual([HUMAN_ID]);
  });
});

describe('statuses.assign — auto-assignment goes through the ledger', () => {
  it('writes a task_assignments row (reason auto, actor = caller)', async () => {
    const d = await db();
    const { modelProviders, tasks, taskAssignments } = await import('#server/db/schema');
    const secret = await callProc('vault.secrets.create', { name: 'jev-r8', value: 'sk-jev-r8' });
    await d.insert(modelProviders).values({
      id: 'seed-jev-r8',
      label: 'Jev r8',
      baseUrl: 'https://api.typesafe.ai',
      endpoints: ['TYPESAFE-SYSTEMONE'],
    });
    const { setSetting } = await import('#server/domains/settings/settings.service');
    await setSetting(
      'internal_decision',
      JSON.stringify({ providerId: 'seed-jev-r8', model: 'jev-latest', keySecretId: secret.id }),
    );
    await mkUser(HUMAN_ID, 'Rita', 'rita@tandem.local', 'Runner');
    const created = await callProc('tasks.create', { title: 'Auto assign me' });

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'jev-test',
        answers: {
          assignee: { type: 'choice', choice: HUMAN_ID, confidence: 0.95, probabilities: { [HUMAN_ID]: 0.95 } },
        },
      }),
    })) as unknown as typeof fetch;
    try {
      const r = await callProc('statuses.assign', { taskId: created.id });
      expect(r.assigned).toBe(true);
      const row = (await d.select().from(tasks).where(eq(tasks.id, created.id)))[0]!;
      expect(row.assigneeId).toBe(HUMAN_ID);
      const ledger = await d.select().from(taskAssignments).where(eq(taskAssignments.taskId, created.id));
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ employeeId: HUMAN_ID, reason: 'auto', actorId: admin.id, endedAt: null });
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('employees api keys — writes are scoped to an employee', () => {
  it('a key of another employee cannot be renamed or revoked', async () => {
    const d = await db();
    const { apikey } = await import('#server/db/schema');
    const a = await callProc('employees.create', {
      name: 'Key Owner',
      email: 'key-a@tandem.local',
      kind: 'human',
      title: 'T',
      supervisorIds: [],
    });
    const b = await callProc('employees.create', {
      name: 'Other Person',
      email: 'key-b@tandem.local',
      kind: 'human',
      title: 'T',
      supervisorIds: [],
    });
    const minted = await callProc('employees.createApiKey', { employeeId: a.id, name: 'a-key' });

    // wrong owner: the key is invisible, so nothing is renamed
    await expect(
      callProc('employees.updateApiKey', { keyId: minted.id, employeeId: b.id, name: 'stolen' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await d.select().from(apikey).where(eq(apikey.id, minted.id)))[0]!.name).toBe('a-key');

    await callProc('employees.updateApiKey', { keyId: minted.id, employeeId: a.id, name: 'a-key-2' });
    expect((await d.select().from(apikey).where(eq(apikey.id, minted.id)))[0]!.name).toBe('a-key-2');

    // wrong owner cannot revoke either
    await expect(callProc('employees.revokeApiKey', { keyId: minted.id, employeeId: b.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await d.select().from(apikey).where(eq(apikey.id, minted.id))).toHaveLength(1);

    await callProc('employees.revokeApiKey', { keyId: minted.id, employeeId: a.id });
    expect(await d.select().from(apikey).where(eq(apikey.id, minted.id))).toHaveLength(0);
  });
});

describe('tasks.listPaged — total order across same-ms rows', () => {
  it('pages without duplicates or gaps when createdAt ties', async () => {
    const d = await db();
    const { tasks } = await import('#server/db/schema');
    const shared = new Date('2026-01-01T00:00:00.000Z');
    for (const id of ['tie-a', 'tie-b', 'tie-c', 'tie-d', 'tie-e']) {
      await d.insert(tasks).values({ id, title: id, createdAt: shared, updatedAt: shared });
    }
    await d.insert(tasks).values({ id: 'tie-newest', title: 'newest', createdAt: new Date(shared.getTime() + 1000) });

    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const res = await callProc('tasks.listPaged', { page, pageSize: 2 });
      expect(res.total).toBe(6);
      seen.push(...res.data.map((r: { id: string }) => r.id));
    }
    // createdAt desc, then id desc — deterministic even when every row shares a millisecond
    expect(seen).toEqual(['tie-newest', 'tie-e', 'tie-d', 'tie-c', 'tie-b', 'tie-a']);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
