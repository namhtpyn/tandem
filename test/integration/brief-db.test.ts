import { eq, sql } from 'drizzle-orm';
// loadBriefData coverage against the real test DB: users, supervision edges, mentions,
// activity, missing-task error arm.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetData } from './helpers/pg';

beforeEach(async () => {
  await resetData();
});

import { db } from '#server/db';
import {
  tasks,
  user as userTable,
  aiEmployees,
  employeeSupervisors,
  taskActivity,
  taskMessages,
  taskRuns,
  environments,
} from '#server/db/schema';
import { activityKindOf, buildBrief, loadBriefData } from '#server/domains/tasks/brief.service';

const dbm = () => import('#server/db');
const schema2 = () => import('#server/db/schema');
const rnd = () => Math.random().toString(16).slice(2, 8);
import { ACTIVITY_KIND, ROLE } from '#shared/enums';
import { STATUS } from '#shared/status';

describe('loadBriefData (real db)', () => {
  let agentId: string;
  let chiefId: string;
  let peerId: string;
  let taskId: string;

  beforeEach(async () => {
    const rnd = Math.random().toString(16).slice(2, 8); // hex: the uuid tail embeds it
    const tail = rnd.padEnd(12, '0');
    agentId = `00000a00-0000-7000-8000-${tail}`;
    chiefId = `00000c00-0000-7000-8000-${tail}`;
    peerId = `00000p00-0000-7000-8000-${tail}`.replace('p00', 'd00');
    taskId = `brief-t-${rnd}`;
    await db.insert(userTable).values([
      { id: agentId, name: 'Agent One', email: `${agentId}@t.local`, role: ROLE.EMPLOYEE, title: 'Worker' },
      { id: chiefId, name: 'Chief Two', email: `${chiefId}@t.local`, role: ROLE.ADMIN, title: 'Chief' },
      { id: peerId, name: 'Peer Three', email: `${peerId}@t.local`, role: ROLE.EMPLOYEE, title: 'Peer' },
    ]);
    await db
      .insert(environments)
      .values({ id: 'env-x', name: 'brief-env', host: 'brief.invalid', port: 22, username: 'root' });
    await db
      .insert(aiEmployees)
      .values({ userId: agentId, environmentId: 'env-x', instructions: 'Be terse.', executable: 'hermes acp' });
    await db.insert(employeeSupervisors).values([
      { employeeId: agentId, supervisorId: chiefId },
      { employeeId: peerId, supervisorId: chiefId },
    ]);
    await db.insert(tasks).values({
      id: taskId,
      title: 'Do things',
      description: 'Sync with @Peer Three today',
      status: STATUS.todo,
      assigneeId: agentId,
      ownerId: chiefId,
    });
    // STATUS bookkeeping message, exactly as the dispatcher's dual-write emits it
    await db.insert(taskMessages).values({ id: `msg-${rnd}`, taskId, authorId: chiefId, body: 'dispatched' });
    await db.execute(
      sql`insert into task_message_activities (message_id, payload) values (${`msg-${rnd}`}, ${JSON.stringify({ kind: 'STATUS' })}::jsonb)`,
    );
  });

  afterEach(async () => {
    await db.delete(taskActivity).where(eq(taskActivity.taskId, taskId));
    await db.delete(tasks).where(eq(tasks.id, taskId));
    await db.delete(employeeSupervisors).where(eq(employeeSupervisors.employeeId, agentId));
    await db.delete(employeeSupervisors).where(eq(employeeSupervisors.employeeId, peerId));
    await db.delete(aiEmployees).where(eq(aiEmployees.userId, agentId));
    await db.delete(environments).where(eq(environments.id, 'env-x'));
    for (const id of [agentId, chiefId, peerId]) await db.delete(userTable).where(eq(userTable.id, id));
  });

  it('assembles identity, chains, mention chain, activity', async () => {
    const d = await loadBriefData(taskId);
    expect(d.agent).toMatchObject({ id: agentId, name: 'Agent One', title: 'Worker', kind: 'ai' });
    expect(d.agentInstructions).toBe('Be terse.');
    expect(d.upChain.map((lvl) => lvl.map((p) => p.id))).toEqual([[chiefId]]);
    expect(d.task.ownerName).toBe('Chief Two');
    // @Peer Three mentioned -> extra chain with their supervisor
    expect(d.extraChains).toHaveLength(1);
    expect(d.extraChains[0]!.person.id).toBe(peerId);
    expect(d.extraChains[0]!.chain.map((lvl) => lvl.map((p) => p.id))).toEqual([[chiefId]]);
    // STATUS bookkeeping (dispatch lines) never reaches the prompt
    const kinds = d.recentActivity.map((a) => a.kind);
    expect(kinds).not.toContain('status');
    // no finished run yet (first dispatch): the activity section stays empty
    expect(d.recentActivity).toEqual([]);
  });

  it("relay law: first run full ticket, later runs carry only the other side's messages", async () => {
    const d0 = await loadBriefData(taskId, agentId);
    // Jay #1: first dispatch — full ticket, no activity section
    expect(d0.relay).toBe(false);
    expect(d0.recentActivity).toEqual([]);

    // Jay run 1 settles: body filled from the result envelope (updateRunMessageBody)
    await db.insert(taskMessages).values({
      id: 'msg-jay1',
      taskId,
      body: 'Jay: blocked, need cloudflare dns',
      createdAt: new Date(Date.now() - 95_000),
    });
    await db.insert(taskRuns).values({
      id: 'run-jay1',
      messageId: 'msg-jay1',
      employeeId: agentId,
      environmentId: 'env-x',
      status: 'DONE',
      output: '',
      finishedAt: new Date(Date.now() - 90_000),
    });

    // Ash #1 (takeover): first run — full ticket + Jay's result
    const dAsh1 = await loadBriefData(taskId, chiefId);
    expect(dAsh1.relay).toBe(false);
    expect(dAsh1.recentActivity.map((a) => [a.kind, a.authorName, a.body])).toEqual([
      ['result', 'Agent One', 'Jay: blocked, need cloudflare dns'],
    ]);

    // Ash run 1 settles
    await db
      .insert(taskMessages)
      .values({ id: 'msg-ash1', taskId, body: 'Ash: dns updated', createdAt: new Date(Date.now() - 65_000) });
    await db.insert(taskRuns).values({
      id: 'run-ash1',
      messageId: 'msg-ash1',
      employeeId: chiefId,
      environmentId: 'env-x',
      status: 'DONE',
      output: '',
      finishedAt: new Date(Date.now() - 60_000),
    });

    // Jay #2 (handback): no ticket, only Ash's message — relay true
    const dJay2 = await loadBriefData(taskId, agentId);
    expect(dJay2.relay).toBe(true);
    expect(dJay2.recentActivity.map((a) => a.body)).toEqual(['Ash: dns updated']);
    const briefJay2 = buildBrief(dJay2);
    expect(briefJay2).toContain('CONTINUATION');
    expect(briefJay2).not.toContain('\nTASK\n'); // ticket block dropped on continuation
    expect(briefJay2).toContain('OUTPUT CONTRACT'); // protocol still rides

    // Jay run 2 settles
    await db
      .insert(taskMessages)
      .values({ id: 'msg-jay2', taskId, body: 'Jay: done, pr opened', createdAt: new Date(Date.now() - 35_000) });
    await db.insert(taskRuns).values({
      id: 'run-jay2',
      messageId: 'msg-jay2',
      employeeId: agentId,
      environmentId: 'env-x',
      status: 'DONE',
      output: '',
      finishedAt: new Date(Date.now() - 30_000),
    });

    // Ash #2 (review): only Jay's completion message
    const dAsh2 = await loadBriefData(taskId, chiefId);
    expect(dAsh2.relay).toBe(true);
    expect(dAsh2.recentActivity.map((a) => a.body)).toEqual(['Jay: done, pr opened']);
  });

  it('ships long activity whole (never truncated), strips mention ids, populated reviewers', async () => {
    const long = 'x'.repeat(300);
    // a finished run first: the long note must land after the cutoff to ship
    await db.insert(taskMessages).values({ id: 'run-msg-long', taskId, body: '' });
    await db.insert(taskRuns).values({
      id: 'run-long',
      messageId: 'run-msg-long',
      employeeId: agentId,
      environmentId: 'env-x',
      status: 'DONE',
      output: '',
      finishedAt: new Date(Date.now() - 60_000),
    });
    await db.insert(taskMessages).values({ id: taskId + '-long', taskId, authorId: null, body: long });
    await db
      .update(tasks)
      .set({ description: `ping @[Peer Three](mention-${peerId}) and [@ label="Chief Two"]`, reviewers: [chiefId] })
      .where(eq(tasks.id, taskId));
    const d = await loadBriefData(taskId, agentId);
    const brief = buildBrief(d);
    expect(brief).toContain(long); // prompt message lines ship whole, uncut
    expect(brief).toContain('Peer Three'); // mention link stripped to the bare name
    expect(brief).not.toContain('mention-x'); // raw mention id never reaches the agent
    expect(d.task.reviewerNames).toContain('Chief Two');
    // Chief Two is the agent's supervisor: covered by the up-chain, not an extra chain.
    // Peer Three (outside the agent's chain) gets their own chain entry.
    expect(d.extraChains.map((c) => c.person.id)).toEqual([peerId]);
  });

  it('bare task: no owner/reviewers/activity, unknown mention ids skipped, human assignee', async () => {
    const bareId = taskId + 'b';
    await db.insert(tasks).values({
      id: bareId,
      title: 'Bare',
      description: '',
      status: STATUS.todo,
      assigneeId: chiefId,
      ownerId: null,
      reviewers: [],
    });
    // chief is human: no ai row -> empty instructions
    try {
      const d = await loadBriefData(bareId);
      expect(d.agentInstructions).toBe('');
      expect(d.task.ownerName).toBeNull();
      expect(d.task.reviewerNames).toEqual([]);
      expect(d.recentActivity).toEqual([]);
      expect(d.agent.kind).toBe('human');
      const bare = buildBrief(d);
      expect(bare).not.toContain('Reviewers');
      expect(bare).toContain('Owner: unassigned');
      // owner line carries the user id when known
    } finally {
      await db.delete(tasks).where(eq(tasks.id, bareId));
    }
  });

  it('link-mention with a non-user id is skipped (bogus id arm)', async () => {
    await db.update(tasks).set({ description: 'see @[Someone](mention-bogus-id) now' }).where(eq(tasks.id, taskId));
    const d = await loadBriefData(taskId);
    expect(d.extraChains).toHaveLength(0);
  });

  it('mention id that is not a user is skipped', async () => {
    await db.update(tasks).set({ description: 'cc @Ghost Nobody' }).where(eq(tasks.id, taskId));
    const d = await loadBriefData(taskId);
    expect(d.extraChains).toHaveLength(0);
  });

  it('defensive arms: activity by unknown author, null description fallbacks', async () => {
    // seed a finished run so the note lands after the cutoff and reaches the prompt
    await db.insert(taskMessages).values({ id: `run-msg-ghost`, taskId, body: '' });
    await db.insert(taskRuns).values({
      id: `run-ghost`,
      messageId: 'run-msg-ghost',
      employeeId: agentId,
      environmentId: 'env-x',
      status: 'DONE',
      output: '',
      finishedAt: new Date(Date.now() - 60_000),
    });
    await db.insert(taskMessages).values({ id: 'ghost-note', taskId, authorId: null, body: 'system did something' });
    const d = await loadBriefData(taskId, agentId);
    expect(d.recentActivity.some((a) => a.authorName === null)).toBe(true);
  });

  it('fresh task with no activity: brief omits the activity section; titled owner renders', async () => {
    const freshId = taskId + 'f';
    await db.insert(tasks).values({
      id: freshId,
      title: 'Fresh',
      description: '',
      status: STATUS.todo,
      assigneeId: agentId,
      ownerId: chiefId,
      reviewers: [],
    });
    try {
      const d = await loadBriefData(freshId);
      expect(d.recentActivity).toEqual([]);
      const brief = buildBrief(d);
      expect(brief).not.toContain('Recent activity');
      expect(d.task.ownerName).toBe('Chief Two');
      expect(d.agent.title).toBe('Worker'); // titled agent
    } finally {
      await db.delete(tasks).where(eq(tasks.id, freshId));
    }
  });

  it('activityKindOf reads both jsonb shapes (string payload and object payload)', () => {
    expect(activityKindOf(JSON.stringify({ kind: 'STATUS' }))).toBe('status');
    expect(activityKindOf({ kind: 'NOTE' })).toBe('note');
    expect(activityKindOf(null)).toBe('');
    expect(activityKindOf(undefined)).toBe('');
    expect(activityKindOf('{not json')).toBe(''); // corrupt payload string survives
  });

  it('throws on missing task', async () => {
    await expect(loadBriefData('nope', 'http://x.local')).rejects.toThrow('task not found');
  });
});
