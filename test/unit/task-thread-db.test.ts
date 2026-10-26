// task thread (task_messages base + per-kind extensions): emitters dual-write
// during the transition; the thread procs read one ordered list.
import { beforeEach, describe, expect, it } from 'vitest';

import './api-harness';

const ADMIN_ID = '00000000-0000-7000-8000-3f18cbc16519';

async function dbm() {
  return await import('#server/db');
}
async function schema() {
  return await import('#server/db/schema');
}
async function threadSvc() {
  return await import('#server/domains/tasks/thread.service');
}

async function callProc(path: string, input?: unknown): Promise<any> {
  const { appRouter: router } = await import('#server/domains/app.router');
  const { buildServerContext } = await import('#server/domains/kernel/context');
  const context = buildServerContext(new Headers());
  (context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => ({
    user: { id: ADMIN_ID, name: 'Test Admin', email: 'test@tandem.local', emailVerified: true },
  });
  let node: Record<string, unknown> = router as unknown as Record<string, unknown>;
  for (const key of path.split('.')) node = node[key] as Record<string, unknown>;
  const internals = node['~orpc'] as { handler: (opts: unknown) => Promise<unknown> };
  return await internals.handler({ input, context, signal: new AbortController().signal });
}

let agentSeq = 0;
async function mkAiAgent() {
  const { db } = await dbm();
  const { environments, user, aiEmployees } = await schema();
  const n = ++agentSeq;
  const envId = `env-${n}`;
  await db.insert(environments).values({
    id: envId,
    name: `E${n}`,
    host: '127.0.0.1',
    port: '2222',
    username: '00000000-0000-7000-8000-51e69892ab49',
  });
  const id = `0000000${n}-0000-7000-8000-${String(n).padStart(12, '0')}`;
  await db.insert(user).values({
    id,
    name: 'Robby',
    email: `robby-thread${n}@tandem.local`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(aiEmployees).values({ userId: id, environmentId: envId, instructions: '', executable: 'hermes acp' });
  return id;
}

beforeEach(async () => {
  // tasks.created_by/owner_id FK target: the mocked session user must exist
  const { db } = await dbm();
  const { user } = await schema();
  await db.insert(user).values({
    id: ADMIN_ID,
    name: 'Test Admin',
    email: 'test@tandem.local',
    emailVerified: true,
    role: 'ADMIN',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

describe('task thread (task_messages base + extensions)', () => {
  it('returns run + activity messages in createdAt order with the run payload mapped', async () => {
    const agentId = await mkAiAgent();
    const t = await callProc('tasks.create', { title: 'Thread order', assigneeId: agentId });
    const { db } = await dbm();
    const { taskRuns } = await schema();
    const svc = await threadSvc();

    // dispatch note first, then the run — the same relative order the runner writes
    await svc.insertActivityMessage({
      taskId: t.id,
      authorId: null,
      body: 'dispatched to Robby on E1',
      payload: { kind: 'STATUS', dispatched: true },
    });
    const started = new Date();
    await db.insert(taskRuns).values({
      id: 'r-thread-1',
      taskId: t.id,
      employeeId: agentId,
      environmentId: 'env-1',
      status: 'RUNNING',
      output: '',
      startedAt: started,
    });
    await svc.insertRunMessage({ taskId: t.id, authorId: agentId, body: '', runId: 'r-thread-1', createdAt: started });

    const items = (await svc.listTaskThread(t.id)) as Array<Record<string, any>>;
    expect(items.map((i) => i.body)).toEqual(['dispatched to Robby on E1', '']);
    expect(items[1].run).toMatchObject({ id: 'r-thread-1', agentName: 'Robby', status: 'RUNNING', outputs: [] });
    expect(items[1].run.startedAt).toBe(started.toISOString());
    expect(items[0].activity).toMatchObject({ kind: 'STATUS', dispatched: true });
    expect(items[0].authorName).toBeNull();
    expect(items[1].authorName).toBe('Robby');
  });

  it('orders messages within the same createdAt by uuidv7 id (insertion order)', async () => {
    const t = await callProc('tasks.create', { title: 'Tiebreak' });
    const svc = await threadSvc();
    await svc.insertActivityMessage({ taskId: t.id, authorId: null, body: 'first', payload: { kind: 'NOTE' } });
    await svc.insertActivityMessage({ taskId: t.id, authorId: null, body: 'second', payload: { kind: 'NOTE' } });
    const items = (await svc.listTaskThread(t.id)) as Array<{ body: string }>;
    expect(items.map((i) => i.body)).toEqual(['first', 'second']);
  });

  it('groups output attachments onto their run and skips null-runId rows', async () => {
    const agentId = await mkAiAgent();
    const t = await callProc('tasks.create', { title: 'Thread outputs', assigneeId: agentId });
    const { db } = await dbm();
    const { taskRuns, taskAttachments } = await schema();
    const svc = await threadSvc();
    const started = new Date();
    await db.insert(taskRuns).values({
      id: 'r-att',
      taskId: t.id,
      employeeId: agentId,
      environmentId: 'env-1',
      status: 'DONE',
      output: '',
      startedAt: started,
      finishedAt: started,
    });
    await svc.insertRunMessage({ taskId: t.id, authorId: agentId, body: '', runId: 'r-att', createdAt: started });
    await db.insert(taskAttachments).values([
      { id: 'att-1', taskId: t.id, runId: 'r-att', kind: 'output', filename: 'a.txt', mime: 'text/plain', size: 3, sha256: 'aa' },
      // defensive arm: an output attachment with no run never reaches any payload
      { id: 'att-2', taskId: t.id, runId: null, kind: 'output', filename: 'b.txt', mime: 'text/plain', size: 4, sha256: 'bb' },
    ]);
    const items = (await svc.listTaskThread(t.id)) as Array<{ run: { outputs: Array<{ filename: string }> } | null }>;
    expect(items[0].run?.outputs.map((o) => o.filename)).toEqual(['a.txt']);
  });

  it('threadList proc + thread live proc serve the same snapshot', async () => {
    const t = await callProc('tasks.create', { title: 'Proc thread' });
    const svc = await threadSvc();
    await svc.insertActivityMessage({ taskId: t.id, authorId: ADMIN_ID, body: 'human note', payload: { kind: 'NOTE' } });

    const viaProc = await callProc('tasks.threadList', { taskId: t.id });
    expect(viaProc).toHaveLength(1);
    expect(viaProc[0]).toMatchObject({ body: 'human note', authorName: 'Test Admin', run: null });

    const iter = await callProc('tasks.thread', { taskId: t.id });
    const snap = await iter.next();
    await iter.return?.();
    expect((snap.value as Array<{ body: string }>)[0].body).toBe('human note');
  });
});
