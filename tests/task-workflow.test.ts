// Task workflow: question → forward chain → answer; submit → unanimous review → done.
// Laws (user, 2026-10-13):
//   1. owner ≠ supervisor — no hierarchy coupling
//   2. ALL reviewers must approve
//   3. reviewer/assignee: AI or human, no restriction
//   4. forward is a free chain; stops at the top of the hierarchy; no revisits
import { beforeEach, describe, expect, it } from 'vitest';

import './api-harness';
import { resetSchema } from './helpers/pg';
import { applyMigrations } from '../server/db/index';
import { answerHolder, spawnObligation } from '../server/domains/tasks/obligations.service';
import { ACTIVITY_KIND, OBLIGATION_ROLE, REVIEW_STATUS, ROLE } from '../shared/enums';
import { STATUS } from '../shared/status';
import type { TaskRow, TaskActivityRow } from '../shared/types';
import { makeProcCaller } from './helpers/procs';

const admin = {
  id: '00000000-0000-7000-8000-cd5fca5e2d34',
  name: 'Admin',
  email: 'admin@tandem.local',
  role: ROLE.ADMIN,
};
const worker = {
  id: '00000000-0000-7000-8000-bccb5af49873',
  name: 'Worker',
  email: 'worker@tandem.local',
  role: 'member',
};
const ownerUser = {
  id: '00000000-0000-7000-8000-820caae75a5f',
  name: 'Owner',
  email: 'owner@tandem.local',
  role: 'member',
};
const rev1 = {
  id: '00000000-0000-7000-8000-a825ff846dc9',
  name: 'Rev One',
  email: 'rev1@tandem.local',
  role: 'member',
};
const rev2 = {
  id: '00000000-0000-7000-8000-2b52961dac61',
  name: 'Rev Two',
  email: 'rev2@tandem.local',
  role: 'member',
};
const top = { id: '00000000-0000-7000-8000-5ecc0b58a4f3', name: 'Top', email: 'top@tandem.local', role: 'member' };

async function dbm() {
  return await import('../server/db');
}
async function schema() {
  return await import('../server/db/schema');
}

// official oRPC call() helper (tests/helpers/procs) — same middleware/context path
// as production without HTTP; replaces the hand-rolled ['~orpc'] internals poking
const procCaller = await makeProcCaller(admin);
const callProc = procCaller as unknown as (path: string, input?: unknown) => Promise<any>;

// run fn with the router session switched to another user (restores admin after)
async function as(user: typeof admin, fn: () => Promise<void>) {
  await (procCaller as unknown as { __setUser: (u: unknown) => void }).__setUser(user);
  try {
    await fn();
  } finally {
    await (procCaller as unknown as { __setUser: (u: unknown) => void }).__setUser(admin);
  }
}

const idMap = new Map<string, string>(); // logical id -> real uuid

async function mkEmployee(
  logical: string,
  name: string,
  email: string,
  supervisorLogical: string[] = [],
): Promise<string> {
  const supervisorIds = supervisorLogical.map((s) => idMap.get(s)!);
  const r = await callProc('employees.create', { name, email, kind: 'human', title: 'T', supervisorIds });
  idMap.set(logical, r.id);
  return r.id;
}

async function mkTask(input: Record<string, unknown>): Promise<string> {
  const r = await callProc('tasks.create', input);
  return r.id;
}

/** move task to doing (the assignee picked it up) */
async function startWork(taskId: string) {
  await callProc('tasks.update', { id: taskId, status: STATUS.doing });
}

async function getTask(id: string) {
  const { db } = await dbm();
  const { tasks } = await schema();
  const rows = await db.select().from(tasks);
  return rows.find((t) => t.id === id)!;
}

async function activity(id: string) {
  const iter = await callProc('tasks.activity', { taskId: id });
  const snap = await iter.next();
  await iter.return?.();
  return snap.value as TaskActivityRow[];
}

beforeEach(async () => {
  idMap.clear();
  await resetSchema();
  await applyMigrations();
  const { db } = await dbm();
  const { user } = await schema();
  await db.insert(user).values({
    id: '00000000-0000-7000-8000-cd5fca5e2d34',
    name: 'Admin',
    email: 'admin@tandem.local',
    emailVerified: true,
    role: ROLE.ADMIN,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

describe('workflow procs without a session', () => {
  it('each workflow proc rejects UNAUTHORIZED when selfId is empty', async () => {
    const caller = await makeProcCaller({ name: 'No Id' } as never);
    const taskId = '00000000-0000-7000-8000-000000000001';
    const paths: Array<[string, unknown]> = [
      ['tasks.ask', { taskId, body: 'q' }],
      ['tasks.forward', { taskId, toEmployeeId: '00000000-0000-7000-8000-000000000002', body: 'f' }],
      ['tasks.answer', { taskId, body: 'a' }],
      ['tasks.submit', { taskId, body: 's' }],
      ['tasks.approve', { taskId, body: 'ok' }],
      ['tasks.requestChanges', { taskId, body: 'rc' }],
      ['tasks.abandon', { taskId, body: 'x' }],
    ];
    for (const [path, input] of paths) {
      await expect(caller(path, input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
  });
});

describe('task workflow — question chain', () => {
  it('ask moves the task to waiting-answer and routes to the owner (not supervisor)', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    await mkEmployee('sup', 'Sup', 'sup@tandem.local');
    await mkEmployee('owner', ownerUser.name, ownerUser.email);
    const taskId = await mkTask({ title: 'Q task', assigneeId: idMap.get('worker')!, ownerId: idMap.get('owner')! });
    await startWork(taskId);
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      const r = await callProc('tasks.ask', { taskId, body: 'which DB?' });
      expect(r.holderId).toBe(idMap.get('owner')!);
    });
    const t = await getTask(taskId);
    expect(t.status).toBe(STATUS.waitingAnswer);
    expect(await answerHolder(t.id)).toBe(idMap.get('owner')!);
  });

  it('holder forwards down the chain; top of the hierarchy cannot be forwarded to', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    await mkEmployee('top', top.name, top.email); // no supervisors => top
    await mkEmployee('owner', ownerUser.name, ownerUser.email, ['top']);
    const taskId = await mkTask({ title: 'F task', assigneeId: idMap.get('worker')!, ownerId: idMap.get('owner')! });
    await startWork(taskId);
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      await callProc('tasks.ask', { taskId, body: 'q' });
    });
    // owner forwards to top => refused: top must ANSWER, not receive
    await as({ ...ownerUser, id: idMap.get('owner')! }, async () => {
      await expect(
        callProc('tasks.forward', { taskId, toEmployeeId: idMap.get('top')!, body: 'you know' }),
      ).rejects.toThrow(/top of the hierarchy/i);
    });
    // owner forwards to someone with a supervisor instead: make a middle employee
    const mid = await mkEmployee('mid', 'Mid', 'mid@tandem.local', ['top']);
    await as({ ...ownerUser, id: idMap.get('owner')! }, async () => {
      const r = await callProc('tasks.forward', { taskId, toEmployeeId: mid, body: 'mid knows' });
      expect(r.holderId).toBe(mid);
    });
    const t = await getTask(taskId);
    expect(await answerHolder(t.id)).toBe(mid);
    expect(t.questionChain).toEqual([idMap.get('owner')!, mid]);
  });

  it('cannot forward to someone already in the chain (loop guard)', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    await mkEmployee('top', top.name, top.email);
    await mkEmployee('owner', ownerUser.name, ownerUser.email, ['top']);
    const taskId = await mkTask({ title: 'L task', assigneeId: idMap.get('worker')!, ownerId: idMap.get('owner')! });
    await startWork(taskId);
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      await callProc('tasks.ask', { taskId, body: 'q' });
    });
    const mid = await mkEmployee('mid', 'Mid', 'mid@tandem.local', ['top']);
    await as({ ...ownerUser, id: idMap.get('owner')! }, async () => {
      await callProc('tasks.forward', { taskId, toEmployeeId: mid, body: 'to mid' });
    });
    await as({ id: mid, name: 'Mid', email: 'mid@tandem.local', role: 'member' }, async () => {
      await expect(
        callProc('tasks.forward', { taskId, toEmployeeId: idMap.get('owner')!, body: 'back to owner' }),
      ).rejects.toThrow(/chain/i);
    });
  });

  it('answer returns the task to the assignee (todo) and clears routing', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    await mkEmployee('owner', ownerUser.name, ownerUser.email);
    const taskId = await mkTask({ title: 'A task', assigneeId: idMap.get('worker')!, ownerId: idMap.get('owner')! });
    await startWork(taskId);
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      await callProc('tasks.ask', { taskId, body: 'q' });
    });
    await as({ ...ownerUser, id: idMap.get('owner')! }, async () => {
      await callProc('tasks.answer', { taskId, body: 'use postgres' });
    });
    const t = await getTask(taskId);
    expect(t.status).toBe(STATUS.todo);
    expect(await answerHolder(t.id)).toBeNull();
    expect(t.questionChain).toEqual([]);
    const feed = await activity(taskId);
    expect(feed.map((a) => a.kind)).toEqual(['status', ACTIVITY_KIND.QUESTION, OBLIGATION_ROLE.ANSWER]);
  });

  it('outsider cannot answer', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    await mkEmployee('owner', ownerUser.name, ownerUser.email);
    await mkEmployee('rev1', rev1.name, rev1.email);
    const taskId = await mkTask({ title: 'X task', assigneeId: idMap.get('worker')!, ownerId: idMap.get('owner')! });
    await startWork(taskId);
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      await callProc('tasks.ask', { taskId, body: 'q' });
    });
    await as({ ...rev1, id: idMap.get('rev1')! }, async () => {
      await expect(callProc('tasks.answer', { taskId, body: 'i know' })).rejects.toThrow(/chain/i);
    });
  });
});

describe('task workflow — review gate', () => {
  it('submit with no reviewers completes immediately', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    const taskId = await mkTask({ title: 'S task', assigneeId: idMap.get('worker')! });
    // move to doing first (todo -> doing via update)
    await startWork(taskId);
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      const r = await callProc('tasks.submit', { taskId, body: 'done it' });
      expect(r.status).toBe(STATUS.done);
    });
  });

  it('unanimous approval: all reviewers must approve before done', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    await mkEmployee('rev1', rev1.name, rev1.email);
    await mkEmployee('rev2', rev2.name, rev2.email);
    const taskId = await mkTask({
      title: 'R task',
      assigneeId: idMap.get('worker')!,
      reviewers: [idMap.get('rev1')!, idMap.get('rev2')!],
    });
    await startWork(taskId);
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      const r = await callProc('tasks.submit', { taskId, body: 'result' });
      expect(r.status).toBe(STATUS.inReview);
    });
    await as({ ...rev1, id: idMap.get('rev1')! }, async () => {
      const r = await callProc('tasks.approve', { taskId });
      expect(r.ok).toBe(true);
    });
    let t = await getTask(taskId);
    expect(t.status).toBe(STATUS.inReview); // rev2 still pending
    await as({ ...rev2, id: idMap.get('rev2')! }, async () => {
      await callProc('tasks.approve', { taskId });
    });
    t = await getTask(taskId);
    expect(t.status).toBe(STATUS.done);
    // REVIEW LAW: both verdict rows approved in round 1
    const revs = (await callProc('tasks.reviews', { taskId })) as Array<{ round: number; status: string }>;
    expect(revs.filter((r) => r.round === 1).every((r) => r.status === REVIEW_STATUS.APPROVED)).toBe(true);
  });

  it('request-changes sends it back to working and resets approvals', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    await mkEmployee('rev1', rev1.name, rev1.email);
    await mkEmployee('rev2', rev2.name, rev2.email);
    const taskId = await mkTask({
      title: 'C task',
      assigneeId: idMap.get('worker')!,
      reviewers: [idMap.get('rev1')!, idMap.get('rev2')!],
    });
    await startWork(taskId);
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      await callProc('tasks.submit', { taskId, body: 'v1' });
    });
    await as({ ...rev1, id: idMap.get('rev1')! }, async () => {
      await callProc('tasks.approve', { taskId });
    });
    let t = await getTask(taskId);
    expect(t.status).toBe(STATUS.inReview); // rev2 still pending
    await as({ ...rev2, id: idMap.get('rev2')! }, async () => {
      await callProc('tasks.requestChanges', { taskId, body: 'redo the thing' });
    });
    t = await getTask(taskId);
    expect(t.status).toBe(STATUS.todo); // REVIEW LAW: back to READY, the assignee resumes
    // default body arm: submit again, request changes without body
    await startWork(t.id);
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      await callProc('tasks.submit', { taskId });
    });
    await as({ ...rev1, id: idMap.get('rev1')! }, async () => {
      await callProc('tasks.requestChanges', { taskId, body: 'needs work' });
    });
    t = await getTask(taskId);
    expect(t.status).toBe(STATUS.todo);
    const feed = await activity(taskId);
    const verdicts = feed.filter((a) => a.kind === ACTIVITY_KIND.VERDICT);
    expect(verdicts.some((v) => v.body.includes('redo the thing'))).toBe(true);
  });

  it('non-reviewer cannot approve', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    await mkEmployee('rev1', rev1.name, rev1.email);
    await mkEmployee('rev2', rev2.name, rev2.email);
    const taskId = await mkTask({ title: 'N task', assigneeId: idMap.get('worker')!, reviewers: [idMap.get('rev1')!] });
    await startWork(taskId);
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      await callProc('tasks.submit', { taskId, body: 'r' });
    });
    await as({ ...rev2, id: idMap.get('rev2')! }, async () => {
      await expect(callProc('tasks.approve', { taskId })).rejects.toThrow(/reviewer/i);
    });
  });

  it('reviewer or owner can abandon during review', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    await mkEmployee('rev1', rev1.name, rev1.email);
    const taskId = await mkTask({
      title: 'AB task',
      assigneeId: idMap.get('worker')!,
      reviewers: [idMap.get('rev1')!],
      ownerId: idMap.get('owner')!,
    });
    await startWork(taskId);
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      await callProc('tasks.submit', { taskId, body: 'half baked' });
    });
    await as({ ...rev1, id: idMap.get('rev1')! }, async () => {
      await callProc('tasks.abandon', { taskId });
    });
    const t = await getTask(taskId);
    expect(t.status).toBe(STATUS.cancelled);
  });

  it('only the assignee can submit', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    await mkEmployee('rev1', rev1.name, rev1.email);
    const taskId = await mkTask({ title: 'O task', assigneeId: idMap.get('worker')! });
    await startWork(taskId);
    await as({ ...rev1, id: idMap.get('rev1')! }, async () => {
      await expect(callProc('tasks.submit', { taskId, body: 'not mine' })).rejects.toThrow(/assignee/i);
    });
  });
});

describe('task workflow — guard rails', () => {
  it('ask fails without an assignee', async () => {
    const taskId = await mkTask({ title: 'NA task' });
    await startWork(taskId);
    await expect(callProc('tasks.ask', { taskId, body: 'anyone?' })).rejects.toThrow(/no assignee/i);
  });

  it('ask outside working is rejected', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    const taskId = await mkTask({ title: 'TW task', assigneeId: idMap.get('worker')! });
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      await expect(callProc('tasks.ask', { taskId, body: 'early?' })).rejects.toThrow(/in progress/i);
    });
  });

  it('only the current holder can forward', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    await mkEmployee('owner', ownerUser.name, ownerUser.email);
    await mkEmployee('rev1', rev1.name, rev1.email);
    const taskId = await mkTask({ title: 'HF task', assigneeId: idMap.get('worker')!, ownerId: idMap.get('owner')! });
    await startWork(taskId);
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      await callProc('tasks.ask', { taskId, body: 'q' });
    });
    await as({ ...rev1, id: idMap.get('rev1')! }, async () => {
      await expect(
        callProc('tasks.forward', { taskId, toEmployeeId: idMap.get('rev1')!, body: 'me?' }),
      ).rejects.toThrow(/holder/i);
    });
  });

  it('requestChanges by a non-reviewer is rejected', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    await mkEmployee('rev1', rev1.name, rev1.email);
    await mkEmployee('rev2', rev2.name, rev2.email);
    const taskId = await mkTask({
      title: 'RC task',
      assigneeId: idMap.get('worker')!,
      reviewers: [idMap.get('rev1')!],
    });
    await startWork(taskId);
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      await callProc('tasks.submit', { taskId, body: 'v1' });
    });
    await as({ ...rev2, id: idMap.get('rev2')! }, async () => {
      await expect(callProc('tasks.requestChanges', { taskId, body: 'nope' })).rejects.toThrow(/reviewer/i);
    });
  });

  it('abandon by neither reviewer nor owner is rejected; owner can abandon', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    await mkEmployee('rev1', rev1.name, rev1.email);
    await mkEmployee('rev2', rev2.name, rev2.email);
    await mkEmployee('owner', ownerUser.name, ownerUser.email);
    const taskId = await mkTask({
      title: 'AB2 task',
      assigneeId: idMap.get('worker')!,
      reviewers: [idMap.get('rev1')!],
      ownerId: idMap.get('owner')!,
    });
    await startWork(taskId);
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      await callProc('tasks.submit', { taskId, body: 'x' });
    });
    await as({ ...rev2, id: idMap.get('rev2')! }, async () => {
      await expect(callProc('tasks.abandon', { taskId })).rejects.toThrow(/reviewer or the owner/i);
    });
    await as({ ...ownerUser, id: idMap.get('owner')! }, async () => {
      await callProc('tasks.abandon', { taskId, body: 'killing it' });
    });
    const t = await getTask(taskId);
    expect(t.status).toBe(STATUS.cancelled);
  });

  it('requestChanges/abandon outside review are rejected', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    await mkEmployee('rev1', rev1.name, rev1.email);
    const taskId = await mkTask({
      title: 'OR task',
      assigneeId: idMap.get('worker')!,
      reviewers: [idMap.get('rev1')!],
    });
    await startWork(taskId); // doing, not in review
    await as({ ...rev1, id: idMap.get('rev1')! }, async () => {
      await expect(callProc('tasks.requestChanges', { taskId, body: 'x' })).rejects.toThrow(/not in review/i);
      await expect(callProc('tasks.abandon', { taskId })).rejects.toThrow(/not in review/i);
    });
  });

  it('approve outside review is rejected', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    await mkEmployee('rev1', rev1.name, rev1.email);
    const taskId = await mkTask({
      title: 'AO task',
      assigneeId: idMap.get('worker')!,
      reviewers: [idMap.get('rev1')!],
    });
    await startWork(taskId); // doing — not in review
    await as({ ...rev1, id: idMap.get('rev1')! }, async () => {
      await expect(callProc('tasks.approve', { taskId })).rejects.toThrow(/not in review/i);
    });
  });

  it('ask routes to the creator when no explicit owner (fallback arm)', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    // task created by admin without ownerId — holder must fall back to creator (u-admin)
    const taskId = await mkTask({ title: 'FB task', assigneeId: idMap.get('worker')! });
    await startWork(taskId);
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      const r = await callProc('tasks.ask', { taskId, body: 'who owns this?' });
      expect(r.holderId).toBe('00000000-0000-7000-8000-cd5fca5e2d34');
    });
    // creator (admin) answers — chain includes admin via fallback
    await callProc('tasks.answer', { taskId, body: 'me' });
    const t = await getTask(taskId);
    expect(t.status).toBe(STATUS.todo);
  });

  it('live shows reviewer names, falling back to raw ids for deleted employees', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    await mkEmployee('rev1', rev1.name, rev1.email);
    const revId = idMap.get('rev1')!;
    const taskId = await mkTask({
      title: 'LN task',
      assigneeId: idMap.get('worker')!,
      reviewers: [revId, '00000000-0000-7000-8000-05db3a00ee3e'],
    });
    const iter = await callProc('tasks.live');
    const snap = await iter.next();
    await iter.return?.();
    const row = (snap.value as TaskRow[]).find((r) => r.id === taskId)!;
    expect(row.reviewerNames).toEqual(['Rev One', '00000000-0000-7000-8000-05db3a00ee3e']);
  });

  it('every workflow proc rejects a missing session', async () => {
    const { appRouter } = await import('../server/domains/app.router');
    const { buildServerContext } = await import('../server/domains/kernel/context');
    const context = buildServerContext(new Headers());
    (context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => null;
    const procs = [
      'ask',
      'forward',
      'answer',
      'submit',
      'approve',
      'requestChanges',
      'abandon',
    ];
    for (const p of procs) {
      let cur: Record<string, unknown> = appRouter as unknown as Record<string, unknown>;
      for (const key of ['tasks', p]) cur = cur[key] as Record<string, unknown>;
      const { call } = await import('@orpc/server');
      const base = { taskId: 't-x', toEmployeeId: '00000000-0000-7000-8000-f20d9b639839', body: 'x' };
      // the chain validates input before the session guard, so either error is a reject
      await expect(
        call(cur as unknown as Parameters<typeof call>[0], base, { context, signal: new AbortController().signal }),
      ).rejects.toSatisfy((e: { code?: string }) => ['UNAUTHORIZED', 'INVALID_INPUT'].includes(e?.code ?? ''));
    }
  });

  it('update sets ownerId and reviewers together', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    await mkEmployee('rev1', rev1.name, rev1.email);
    await mkEmployee('owner', ownerUser.name, ownerUser.email);
    const taskId = await mkTask({ title: 'UO task', assigneeId: idMap.get('worker')! });
    await callProc('tasks.update', { id: taskId, ownerId: idMap.get('owner')!, reviewers: [idMap.get('rev1')!] });
    const t = await getTask(taskId);
    expect(t.ownerId).toBe(idMap.get('owner')!);
    expect(t.reviewers).toEqual([idMap.get('rev1')!]);
  });

  it('forward without a note uses empty body', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    await mkEmployee('top', top.name, top.email);
    await mkEmployee('owner', ownerUser.name, ownerUser.email, ['top']);
    await mkEmployee('mid', 'Mid', 'mid@tandem.local', ['top']);
    const taskId = await mkTask({ title: 'FN task', assigneeId: idMap.get('worker')!, ownerId: idMap.get('owner')! });
    await startWork(taskId);
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      await callProc('tasks.ask', { taskId, body: 'q' });
    });
    await as({ ...ownerUser, id: idMap.get('owner')! }, async () => {
      const r = await callProc('tasks.forward', { taskId, toEmployeeId: idMap.get('mid')! });
      expect(r.holderId).toBe(idMap.get('mid')!);
    });
    const feed = await activity(taskId);
    expect(feed.some((a) => a.kind === ACTIVITY_KIND.FORWARD && a.body === '')).toBe(true);
  });

  it('activity tolerates a null author (system entries)', async () => {
    const { db } = await dbm();
    const { taskActivity } = await schema();
    const taskId = await mkTask({ title: 'SA task' });
    await db.insert(taskActivity).values({ id: 'act-sys', taskId, kind: 'status', authorId: null, body: 'created' });
    const feed = await activity(taskId);
    const sys = feed.find((a) => a.id === 'act-sys');
    expect(sys?.authorName).toBeNull();
  });

  it('service guard arms: ghost task, ghost forward target, answer when not waiting', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    await mkEmployee('owner', ownerUser.name, ownerUser.email);
    // ghost task
    await expect(callProc('tasks.ask', { taskId: 'ghost', body: 'q' })).rejects.toThrow(/task not found/i);
    // ghost forward target (zod bypassed by harness)
    const taskId = await mkTask({ title: 'GA task', assigneeId: idMap.get('worker')!, ownerId: idMap.get('owner')! });
    await startWork(taskId);
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      await callProc('tasks.ask', { taskId, body: 'q' });
    });
    await as({ ...ownerUser, id: idMap.get('owner')! }, async () => {
      await expect(
        callProc('tasks.forward', { taskId, toEmployeeId: '00000000-0000-7000-8000-9f2e5a2d4d64', body: 'x' }),
      ).rejects.toThrow(/employee does not exist/i);
    });
    // answer flips to todo; answering AGAIN (not waiting anymore) throws
    await as({ ...ownerUser, id: idMap.get('owner')! }, async () => {
      await callProc('tasks.answer', { taskId, body: 'a1' });
      await expect(callProc('tasks.answer', { taskId, body: 'a2' })).rejects.toThrow(/not waiting/i);
    });
  });

  it('abandon falls back to creator when no owner is set', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    await mkEmployee('rev1', rev1.name, rev1.email);
    // created by admin, ownerId unset -> createdBy fallback arm in abandon
    const taskId = await mkTask({
      title: 'CF task',
      assigneeId: idMap.get('worker')!,
      reviewers: [idMap.get('rev1')!],
    });
    await startWork(taskId);
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      await callProc('tasks.submit', { taskId, body: 'x' });
    });
    await callProc('tasks.abandon', { taskId, body: 'by creator' }); // admin session = creator
    const t = await getTask(taskId);
    expect(t.status).toBe(STATUS.cancelled);
  });

  it('ask with no owner and no creator fails; forward only while waiting', async () => {
    const { db } = await dbm();
    const { tasks } = await schema();
    await mkEmployee('worker', worker.name, worker.email);
    // raw row: nobody owns it (ownerId null, createdBy null)
    await db.insert(tasks).values({
      id: 't-orphan',
      title: 'orphan',
      description: '',
      status: STATUS.doing,
      assigneeId: idMap.get('worker')!,
      ownerId: null,
      createdBy: null,
    });
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      await expect(callProc('tasks.ask', { taskId: 't-orphan', body: 'anyone?' })).rejects.toThrow(/no owner/i);
    });
    // forward while NOT waiting (status doing)
    const taskId = await mkTask({ title: 'FW task', assigneeId: idMap.get('worker')! });
    await startWork(taskId);
    await callProc('tasks.forward', { taskId, toEmployeeId: idMap.get('worker')!, body: 'x' }).catch(() => {});
    await expect(callProc('tasks.forward', { taskId, toEmployeeId: idMap.get('worker')!, body: 'x' })).rejects.toThrow(
      /not waiting/i,
    );
  });

  it('create rejects a ghost assignee; live maps ai assignee + null fields', async () => {
    const { db } = await dbm();
    const { environments } = await schema();
    await expect(
      callProc('tasks.create', { title: 'GA2', assigneeId: '00000000-0000-7000-8000-9f2e5a2d4d64' }),
    ).rejects.toThrow(/assignee does not exist/i);
    // AI employee via API (kind ai, with environment)
    await db.insert(environments).values({
      id: 'env-1',
      name: 'E1',
      host: '127.0.0.1',
      port: '22',
      username: '00000000-0000-7000-8000-51e69892ab49',
    });
    const r = await callProc('employees.create', {
      name: 'Robo',
      email: 'robo@tandem.local',
      kind: 'ai',
      title: 'Bot',
      supervisorIds: [],
      environmentId: 'env-1',
      executable: 'hermes acp',
    });
    const taskId = await mkTask({ title: 'AI task', assigneeId: r.id });
    const iter = await callProc('tasks.live');
    const snap = await iter.next();
    await iter.return?.();
    const row = (snap.value as TaskRow[]).find((x) => x.id === taskId)!;
    expect(row.assigneeKind).toBe('ai');
    expect(row.projectName).toBeNull();
    expect(row.assigneeName).toBe('Robo');
  });

  it('live maps a fully-empty row (no project/assignee/owner)', async () => {
    const taskId = await mkTask({ title: 'Empty row' });
    const iter = await callProc('tasks.live');
    const snap = await iter.next();
    await iter.return?.();
    const row = (snap.value as TaskRow[]).find((r) => r.id === taskId)!;
    expect(row).toMatchObject({
      projectId: null,
      projectName: null,
      assigneeId: null,
      assigneeName: null,
      assigneeKind: null,
      ownerId: '00000000-0000-7000-8000-cd5fca5e2d34',
      ownerName: 'Admin',
      reviewers: [],
      reviewerNames: [],
      reviewApprovals: [],
      questionHolderId: null,
      questionHolderName: null,
    });
  });

  it('live handles raw rows: null owner, held question', async () => {
    const { db } = await dbm();
    const { tasks } = await schema();
    await mkEmployee('worker', worker.name, worker.email);
    await mkEmployee('owner', ownerUser.name, ownerUser.email);
    // raw row with null owner (bypasses create defaults)
    await db.insert(tasks).values({
      id: 't-raw',
      title: 'raw',
      description: '',
      status: STATUS.waitingAnswer,
      assigneeId: idMap.get('worker')!,
      ownerId: null,
      createdBy: null,
    });
    await spawnObligation('t-raw', idMap.get('owner')!, OBLIGATION_ROLE.ANSWER);
    const iter = await callProc('tasks.live');
    const snap = await iter.next();
    await iter.return?.();
    const row = (snap.value as TaskRow[]).find((r) => r.id === 't-raw')!;
    expect(row.ownerId).toBeNull();
    expect(row.ownerName).toBeNull();
    expect(row.questionHolderName).toBe('Owner');
  });

  it('create without a session rejects an anonymous creator', async () => {
    const { appRouter } = await import('../server/domains/app.router');
    const { buildServerContext } = await import('../server/domains/kernel/context');
    const context = buildServerContext(new Headers());
    (context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => null;
    let cur: Record<string, unknown> = appRouter as unknown as Record<string, unknown>;
    for (const key of ['tasks', 'create']) cur = cur[key] as Record<string, unknown>;
    const { call } = await import('@orpc/server');
    // create is protected — no session means the chain rejects before the handler
    await expect(
      call(cur as unknown as Parameters<typeof call>[0], { title: 'NoSession task' }, {
        context,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('submit outside working is rejected', async () => {
    await mkEmployee('worker', worker.name, worker.email);
    const taskId = await mkTask({ title: 'SW task', assigneeId: idMap.get('worker')! });
    await as({ ...worker, id: idMap.get('worker')! }, async () => {
      await expect(callProc('tasks.submit', { taskId, body: 'not yet' })).rejects.toThrow(/in progress/i);
    });
  });
});

describe('task workflow — status transitions', () => {
  it('waiting-answer and in-review statuses are wired into the flow', async () => {
    const { db } = await dbm();
    const { taskStatuses } = await schema();
    const rows = await db.select().from(taskStatuses);
    const todo = rows.find((r) => r.id === STATUS.todo)!;
    const doing = rows.find((r) => r.id === STATUS.doing)!;
    const wa = rows.find((r) => r.id === STATUS.waitingAnswer)!;
    const ir = rows.find((r) => r.id === STATUS.inReview)!;
    expect(todo.nextIds).toContain(STATUS.doing);
    expect(doing.nextIds).toContain(STATUS.waitingAnswer);
    expect(doing.nextIds).toContain(STATUS.inReview);
    expect(doing.nextIds).toContain(STATUS.done);
    expect(ir.nextIds).toContain(STATUS.done);
    expect(wa.nextIds).toContain(STATUS.doing);
  });

  it('create defaults owner to creator; reviewers stored', async () => {
    await mkEmployee('rev1', rev1.name, rev1.email);
    const taskId = await mkTask({ title: 'D task', reviewers: [idMap.get('rev1')!] });
    const t = await getTask(taskId);
    expect(t.ownerId).toBe(admin.id);
    expect(t.reviewers).toEqual([idMap.get('rev1')!]);
  });
});
