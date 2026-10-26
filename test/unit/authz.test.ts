// AuthZ: role gates on write procedures (admin / employee) plus the tasks-router
// workflow guards — raw status writes, dispatch eligibility, delete-under-run.
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import './api-harness';
import { ROLE, RUN_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';

import { makeProcCaller } from './helpers/procs.ts';

// the dispatch success arm is proven without spawning a real ACP turn
vi.mock('#server/domains/tasks/runner.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#server/domains/tasks/runner.service')>();
  return {
    ...actual,
    dispatchTask: vi.fn(async (taskId: string) => ({ runId: `mock-run-${taskId}`, finished: Promise.resolve() })),
  };
});

const admin = {
  id: '00000000-0000-7000-8000-9a0000000001',
  name: 'Gate Admin',
  email: 'gate-admin@tandem.local',
  role: ROLE.ADMIN,
};
const employee = {
  id: '00000000-0000-7000-8000-9a0000000002',
  name: 'Gate Employee',
  email: 'gate-employee@tandem.local',
  role: ROLE.EMPLOYEE,
};
const viewer = {
  id: '00000000-0000-7000-8000-9a0000000003',
  name: 'Gate Viewer',
  email: 'gate-viewer@tandem.local',
  role: ROLE.VIEWER,
};

const procCaller = await makeProcCaller(admin);

// untyped facade: every call below is asserted, not type-inferred
const call = procCaller as unknown as {
  (path: string, input?: unknown): Promise<any>;
  as: (
    user: { id: string; name: string; email: string; role: string },
    path: string,
    input?: unknown,
  ) => Promise<any>;
};

async function dbm() {
  return await import('#server/db');
}
async function schema() {
  return await import('#server/db/schema');
}

/** an AI assignee with a live environment row (dispatch eligibility needs both) */
async function mkAiAssignee() {
  const { db } = await dbm();
  const { environments, aiEmployees } = await schema();
  await db.insert(environments).values({
    id: 'gate-env',
    name: 'Gate env',
    host: '127.0.0.1',
    port: '22',
    username: admin.id,
  });
  await db.insert(aiEmployees).values({ userId: employee.id, environmentId: 'gate-env', executable: 'hermes acp' });
}

beforeEach(async () => {
  const { db } = await dbm();
  const { user } = await schema();
  await db.insert(user).values([admin, employee, viewer].map((u) => ({ ...u, title: 'T' })));
});

describe('admin-only writes', () => {
  it('tasks.update refuses a raw status write', async () => {
    const t = await call('tasks.create', { title: 'Guard' });
    await expect(call('tasks.update', { id: t.id, status: STATUS.doing })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'status changes go through the workflow endpoints',
    });
  });

  it('tasks.update still accepts a status-free patch', async () => {
    const t = await call('tasks.create', { title: 'Guard' });
    await expect(call('tasks.update', { id: t.id, title: 'Renamed' })).resolves.toMatchObject({ ok: true });
  });

  it('listPaged search escapes LIKE wildcards in q', async () => {
    await call('tasks.create', { title: '50% off' });
    await call('tasks.create', { title: 'plain' });
    const hit = (await call('tasks.listPaged', { page: 1, pageSize: 10, q: '50% off' })) as { total: number };
    expect(hit.total).toBe(1);
    // wildcards match literally: '%' finds only the %-title, '_' finds nothing
    const pct = (await call('tasks.listPaged', { page: 1, pageSize: 10, q: '%' })) as { total: number };
    expect(pct.total).toBe(1);
    const und = (await call('tasks.listPaged', { page: 1, pageSize: 10, q: '_' })) as { total: number };
    expect(und.total).toBe(0);
  });

  it('tasks.update rejects a null payload at the edge', async () => {
    const { RPCHandler } = await import('@orpc/server/fetch');
    const { appRouter } = await import('#server/domains/app.router');
    const handler = new RPCHandler(appRouter);
    const req = new Request('http://x/rpc/tasks/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: null }),
    });
    const { response } = await handler.handle(req, {
      prefix: '/rpc',
      context: { getSession: async () => ({ user: admin }) },
    });
    expect(response!.status).toBe(400);
  });

  it('tasks.setStatus moves graph-legally and rejects workflow-only targets', async () => {
    const t = await call('tasks.create', { title: 'SetStatus' });
    // todo -> doing is seeded graph-legal and allowed
    await expect(call('tasks.setStatus', { id: t.id, status: STATUS.doing })).resolves.toMatchObject({ ok: true });
    // doing -> done is review-gated: rejected even though the seeded graph allows it
    await expect(call('tasks.setStatus', { id: t.id, status: STATUS.done })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'use the workflow actions for review, completion and cancellation',
    });
    // doing -> in_review is submit-flow-only
    await expect(call('tasks.setStatus', { id: t.id, status: STATUS.inReview })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    // doing -> blocked is graph-legal and manually allowed (pause work)
    await expect(call('tasks.setStatus', { id: t.id, status: STATUS.blocked })).resolves.toMatchObject({ ok: true });
    // blocked -> done is refused (done is workflow-only)
    await expect(call('tasks.setStatus', { id: t.id, status: STATUS.done })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    // unknown task -> NOT_FOUND
    await expect(call('tasks.setStatus', { id: 'no-such-task', status: STATUS.doing })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // a subtask move refreshes the parent's derived gate (parentId arm)
    const parent = await call('tasks.create', { title: 'SetStatus parent' });
    const child = await call('tasks.create', { title: 'SetStatus child', parentId: parent.id });
    await expect(call('tasks.setStatus', { id: child.id, status: STATUS.doing })).resolves.toMatchObject({ ok: true });
  });

  it('tasks.create only accepts ready-category starting statuses', async () => {
    await expect(call('tasks.create', { title: 'Born working', status: STATUS.doing })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'created tasks must start in a ready-category status',
    });
    await expect(call('tasks.create', { title: 'Born ready', status: STATUS.todo })).resolves.toMatchObject({
      id: expect.any(String),
    });
  });

  it('tasks.remove refuses while a run is RUNNING and succeeds after it ends', async () => {
    const t = await call('tasks.create', { title: 'Busy' });
    const { db } = await dbm();
    const { taskRuns } = await schema();
    const run = await db.insert(taskRuns).values({ taskId: t.id }).returning();
    await expect(call('tasks.remove', { id: t.id })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'cancel the running run first',
    });
    await db.update(taskRuns).set({ status: RUN_STATUS.DONE }).where(eq(taskRuns.id, run[0]!.id));
    await expect(call('tasks.remove', { id: t.id })).resolves.toMatchObject({ ok: true });
  });

  it('removing a subtask re-gates the parent', async () => {
    const parent = await call('tasks.create', { title: 'Parent' });
    const child = await call('tasks.create', { title: 'Child', parentId: parent.id });
    const { db } = await dbm();
    const { tasks } = await schema();
    const blocked = (await db.select().from(tasks)).find((t) => t.id === parent.id)!;
    expect(blocked.status).toBe(STATUS.blocked);
    await call('tasks.remove', { id: child.id });
    const restored = (await db.select().from(tasks)).find((t) => t.id === parent.id)!;
    expect(restored.status).toBe(STATUS.todo);
  });

  it('tasks.dispatch refuses a task that already runs', async () => {
    await mkAiAssignee();
    const t = await call('tasks.create', { title: 'Running', assigneeId: employee.id });
    const { db } = await dbm();
    const { taskRuns } = await schema();
    await db.insert(taskRuns).values({ taskId: t.id });
    await expect(call('tasks.dispatch', { taskId: t.id })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'task already has a running run',
    });
  });

  it('tasks.dispatch refuses a non-ready task', async () => {
    const t = await call('tasks.create', { title: 'Not ready' });
    const { db } = await dbm();
    const { tasks } = await schema();
    await db.update(tasks).set({ status: STATUS.done }).where(eq(tasks.id, t.id));
    await expect(call('tasks.dispatch', { taskId: t.id })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: /not dispatchable/,
    });
  });

  it('tasks.dispatch refuses unassigned and human-assigned tasks', async () => {
    const unassigned = await call('tasks.create', { title: 'Nobody' });
    await expect(call('tasks.dispatch', { taskId: unassigned.id })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: /not dispatchable/,
    });
    const human = await call('tasks.create', { title: 'Human', assigneeId: admin.id });
    await expect(call('tasks.dispatch', { taskId: human.id })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: /not dispatchable/,
    });
  });

  it('tasks.dispatch hands an eligible task to the runner', async () => {
    await mkAiAssignee();
    const t = await call('tasks.create', { title: 'Eligible', assigneeId: employee.id });
    await expect(call('tasks.dispatch', { taskId: t.id })).resolves.toEqual({ runId: `mock-run-${t.id}` });
  });
});
