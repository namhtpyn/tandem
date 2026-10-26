import { eq } from 'drizzle-orm';

import './api-harness';
import type { PgTable } from 'drizzle-orm/pg-core';
// Task routing — obligations (who acts next), assignee history, subtask gating,
// and proposal confirm flow (user laws, 2026-10-15):
//   - obligations replace question_holder_id / review_approvals; answer MOVES on forward
//   - assignments are an append-only ledger; every assignee change flows through it
//   - parent auto-blocks while any child is open; restores when all children terminal
//   - agents propose ([SUBTASKS]/[REASSIGN]); the confirm flow is the single writer;
//     outside-chain nominations escalate to the agent's supervisor; ping-pong refused
import { beforeEach, describe, expect, it } from 'vitest';

import { recentAssignees } from '#server/domains/tasks/assignments.service';
import {
  answerHolder,
  approvalsInRoundBatch,
  openObligations,
  pendingForUser,
  spawnObligation,
} from '#server/domains/tasks/obligations.service';
import { recordProposals } from '#server/domains/tasks/proposals.service';
import {
  OBLIGATION_ROLE,
  OBLIGATION_STATUS,
  PROPOSAL_KIND,
  PROPOSAL_STATUS,
  REVIEW_STATUS,
  ROLE,
  RUN_STATUS,
} from '#shared/enums';
import { STATUS } from '#shared/status';
import type { TaskRow } from '#shared/types';

import { parseRoutingProposals } from '../../app/utils/task-thread.ts';
import { makeProcCaller } from './helpers/procs.ts';

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
const peer = {
  id: '00000000-0000-7000-8000-5c20efd0d33e',
  name: 'Peer Person',
  email: 'peer@tandem.local',
  role: 'member',
};
const report = {
  id: '00000000-0000-7000-8000-e0896d1c89f1',
  name: 'Report Guy',
  email: 'report@tandem.local',
  role: 'member',
};

const procCaller = await makeProcCaller(admin);
const callProc = procCaller as unknown as (path: string, input?: unknown) => Promise<any>;
async function as(user: typeof admin, fn: () => Promise<void>) {
  await (procCaller as unknown as { __setUser: (u: unknown) => void }).__setUser(user);
  try {
    await fn();
  } finally {
    await (procCaller as unknown as { __setUser: (u: unknown) => void }).__setUser(admin);
  }
}

/** act as a created employee (session id must be the real user row — activity FKs) */
async function asEmp(logical: string, fn: () => Promise<void>) {
  const base = { worker, peer, report }[logical as 'worker' | 'peer' | 'report']!;
  await as({ ...base, id: idMap.get(logical)! }, fn);
}

const idMap = new Map<string, string>();

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
  return (await callProc('tasks.create', input)).id;
}

async function getTask(id: string) {
  const { db } = await import('#server/db');
  const { tasks } = await import('#server/db/schema');
  const rows = await db.select().from(tasks);
  return rows.find((t) => t.id === id)!;
}

/** fixture: raw status writes left the API — arrange state directly (parent re-gates, like the workflow does) */
async function setStatus(taskId: string, status: string) {
  const { db } = await import('#server/db');
  const { tasks } = await import('#server/db/schema');
  const { refreshParentGating } = await import('#server/domains/tasks/gating.service');
  await db.update(tasks).set({ status, updatedAt: new Date() }).where(eq(tasks.id, taskId));
  await refreshParentGating(taskId);
}

async function dbRow(table: string, id: string) {
  const { db } = await import('#server/db');
  const mod = await import('#server/db/schema');
  const rows = (await db.select().from((mod as unknown as Record<string, PgTable>)[table])) as Array<
    Record<string, unknown>
  >;
  return rows.find((r) => r.id === id);
}

async function dbRows(table: string) {
  const { db } = await import('#server/db');
  const mod = await import('#server/db/schema');
  return (await db.select().from((mod as unknown as Record<string, PgTable>)[table])) as Array<Record<string, unknown>>;
}

async function mkProposal(taskId: string, kind: PROPOSAL_KIND.SUBTASKS | PROPOSAL_KIND.REASSIGN, payload: unknown) {
  const { db } = await import('#server/db');
  const { taskProposals } = await import('#server/db/schema');
  const id = crypto.randomUUID();
  await db
    .insert(taskProposals)
    .values({ id, taskId, kind, payload: payload as Record<string, unknown>, status: PROPOSAL_STATUS.PROPOSED });
  return id;
}

beforeEach(async () => {
  idMap.clear();
  const { db } = await import('#server/db');
  const { user } = await import('#server/db/schema');
  await db.insert(user).values({
    id: '00000000-0000-7000-8000-cd5fca5e2d34',
    name: 'Admin',
    email: 'admin@tandem.local',
    emailVerified: true,
    role: ROLE.ADMIN,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await mkEmployee('chief', 'Chief Person', 'chief@tandem.local');
  await mkEmployee('worker', worker.name, worker.email, ['chief']);
  await mkEmployee('peer', peer.name, peer.email, ['worker']);
  await mkEmployee('report', report.name, report.email, ['peer']);
  await mkEmployee('solo', 'Solo Person', 'solo@tandem.local');
});

describe('parseRoutingProposals', () => {
  it('parses subtask lists and reassign with reason, ignores prose', () => {
    const out = [
      'Did the analysis.',
      '[SUBTASKS] Draft legal review :: contract clauses :: Peer Person | Fix CSS :: layout bugs :: Report Guy',
      '[REASSIGN] Peer Person — the whole thing is legal work',
      '{"kind": "result", "body": "analysis complete"}',
    ].join('\n');
    expect(parseRoutingProposals(out)).toEqual([
      {
        kind: PROPOSAL_KIND.SUBTASKS,
        items: [
          { title: 'Draft legal review', description: 'contract clauses', assigneeName: 'Peer Person' },
          { title: 'Fix CSS', description: 'layout bugs', assigneeName: 'Report Guy' },
        ],
      },
      { kind: PROPOSAL_KIND.REASSIGN, targetName: 'Peer Person', reason: 'the whole thing is legal work' },
    ]);
  });

  it('empty titles filtered; missing reason optional; no markers = no proposals', () => {
    expect(parseRoutingProposals('[SUBTASKS] :: desc :: Someone')).toEqual([]);
    expect(parseRoutingProposals('[REASSIGN] Nobody')).toEqual([
      { kind: PROPOSAL_KIND.REASSIGN, targetName: 'Nobody', reason: undefined },
    ]);
    expect(parseRoutingProposals('plain output\n{"kind": "result", "body": "done"}')).toEqual([]);
    expect(parseRoutingProposals(null)).toEqual([]);
  });

  it('item budget: >20 items on one line truncate to 20; proposals per output cap at 10', () => {
    const items = Array.from({ length: 25 }, (_, i) => `Item ${i + 1}`).join(' | ');
    const parsed = parseRoutingProposals(`[SUBTASKS] ${items}`);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].kind).toBe(PROPOSAL_KIND.SUBTASKS);
    expect((parsed[0] as { items: unknown[] }).items).toHaveLength(20);

    const lines = Array.from({ length: 12 }, (_, i) => `[REASSIGN] Person ${i + 1}`).join('\n');
    expect(parseRoutingProposals(lines)).toHaveLength(10);
  });
});

describe('obligations', () => {
  it('ask spawns a pending answer obligation; forward MOVES it; answer resolves it', async () => {
    const taskId = await mkTask({ title: 'Q task', assigneeId: idMap.get('worker')!, ownerId: idMap.get('peer')! });
    await setStatus(taskId, STATUS.doing);
    await asEmp('worker', () => callProc('tasks.ask', { taskId, body: 'which db?' }));
    expect(await answerHolder(taskId)).toBe(idMap.get('peer')!);
    expect((await pendingForUser(idMap.get('peer')!)).map((i) => i.taskId)).toContain(taskId);

    await asEmp('peer', () =>
      callProc('tasks.forward', { taskId, toEmployeeId: idMap.get('report')!, body: 'you know' }),
    );
    expect(await answerHolder(taskId)).toBe(idMap.get('report')!);

    await asEmp('report', () => callProc('tasks.answer', { taskId, body: 'postgres' }));
    expect(await answerHolder(taskId)).toBeNull();
  });

  it('REVIEW LAW: rounds open per submit; verdict rows drive unanimity; change_requested returns READY', async () => {
    const taskId = await mkTask({
      title: 'R task',
      assigneeId: idMap.get('worker')!,
      reviewers: [idMap.get('peer')!, idMap.get('report')!],
    });
    await setStatus(taskId, STATUS.doing);
    await asEmp('worker', () => callProc('tasks.submit', { taskId, body: RUN_STATUS.DONE }));
    const t1 = await getTask(taskId);
    expect(t1.status).toBe(STATUS.inReview);
    expect((await pendingForUser(idMap.get('peer')!)).length).toBe(1); // inbox ping per reviewer

    // verdict checklist: one pending row per reviewer in round 1
    const revs1 = (await callProc('tasks.reviews', { taskId })) as Array<{ round: number; status: string }>;
    expect(revs1.map((r) => r.status)).toEqual([OBLIGATION_STATUS.PENDING, OBLIGATION_STATUS.PENDING]);
    expect(revs1.every((r) => r.round === 1)).toBe(true);

    await asEmp('peer', () => callProc('tasks.approve', { taskId, body: 'ok' }));
    expect((await getTask(taskId)).status).toBe(STATUS.inReview); // not unanimous yet

    await asEmp('report', () => callProc('tasks.requestChanges', { taskId, body: 'redo' }));
    expect((await getTask(taskId)).status).toBe(STATUS.todo); // READY — the assignee resumes
    // resubmit opens round 2; round 1 history kept
    await setStatus(taskId, STATUS.doing);
    await asEmp('worker', () => callProc('tasks.submit', { taskId, body: 'v2' }));
    const revs2 = (await callProc('tasks.reviews', { taskId })) as Array<{ round: number; status: string }>;
    expect(revs2.filter((r) => r.round === 2)).toHaveLength(2);
    expect(revs2.filter((r) => r.round === 1).some((r) => r.status === REVIEW_STATUS.CHANGE_REQUESTED)).toBe(true);
    await asEmp('peer', () => callProc('tasks.approve', { taskId, body: 'ok2' }));
    await asEmp('report', () => callProc('tasks.approve', { taskId, body: 'ok3' }));
    expect((await getTask(taskId)).status).toBe(STATUS.done);
    const revs3 = (await callProc('tasks.reviews', { taskId })) as Array<{ round: number; status: string }>;
    expect(revs3.filter((r) => r.round === 2).every((r) => r.status === REVIEW_STATUS.APPROVED)).toBe(true);
  });

  it('REVIEW LAW: approvalsInRoundBatch fulfilled arm — approved round reads as approvals', async () => {
    const taskId = await mkTask({
      title: 'BatchOK',
      assigneeId: idMap.get('worker')!,
      reviewers: [idMap.get('peer')!],
    });
    await setStatus(taskId, STATUS.doing);
    await asEmp('worker', () => callProc('tasks.submit', { taskId, body: 'v1' }));
    await asEmp('peer', () => callProc('tasks.approve', { taskId, body: 'ok' }));
    expect((await getTask(taskId)).status).toBe(STATUS.done);
    const batch = await approvalsInRoundBatch([taskId]);
    expect(batch.get(taskId)).toEqual([idMap.get('peer')!]);
  });

  it('REVIEW LAW: rejectReview refuses a task not in review', async () => {
    const taskId = await mkTask({
      title: 'NotInRev',
      assigneeId: idMap.get('worker')!,
      reviewers: [idMap.get('peer')!],
    });
    const { rejectReview } = await import('#server/domains/tasks/workflow.service');
    await expect(rejectReview(taskId, idMap.get('peer')!, 'nope')).rejects.toThrow(/not in review/i);
  });

  it('REVIEW LAW: approvalsInRoundBatch fulfilled arm (hand-inserted rows, no cancelled)', async () => {
    const { db } = await import('#server/db');
    const { taskObligations } = await import('#server/db/schema');
    const taskId = await mkTask({
      title: 'BatchFul',
      assigneeId: idMap.get('worker')!,
      reviewers: [idMap.get('peer')!],
    });
    const now = new Date();
    await db.insert(taskObligations).values([
      {
        id: crypto.randomUUID(),
        taskId,
        employeeId: idMap.get('peer')!,
        role: OBLIGATION_ROLE.APPROVAL,
        status: OBLIGATION_STATUS.FULFILLED,
        createdAt: now,
        resolvedAt: now,
      },
      {
        id: crypto.randomUUID(),
        taskId,
        employeeId: idMap.get('report')!,
        role: OBLIGATION_ROLE.APPROVAL,
        status: OBLIGATION_STATUS.FULFILLED,
        createdAt: now,
        resolvedAt: now,
      },
    ]);
    const batch = await approvalsInRoundBatch([taskId]);
    expect(batch.get(taskId)).toEqual([idMap.get('peer')!, idMap.get('report')!]);
  });

  it('REVIEW LAW: reject proc requires a session', async () => {
    const anon = await makeProcCaller(null);
    await expect(
      (anon as unknown as (path: string, input?: unknown) => Promise<any>)('tasks.reject', { taskId: 'x' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('REVIEW LAW: human reject cancels the task (terminal verdict)', async () => {
    const taskId = await mkTask({
      title: 'RJ task',
      assigneeId: idMap.get('worker')!,
      reviewers: [idMap.get('peer')!],
    });
    await setStatus(taskId, STATUS.doing);
    await asEmp('worker', () => callProc('tasks.submit', { taskId, body: RUN_STATUS.DONE }));
    await asEmp('peer', () => callProc('tasks.reject', { taskId, body: 'wrong scope entirely' }));
    // body-omitted arm: reject without a note (default body '')
    const taskId2 = await mkTask({ title: 'RJ2', assigneeId: idMap.get('worker')!, reviewers: [idMap.get('peer')!] });
    await setStatus(taskId2, STATUS.doing);
    await asEmp('worker', () => callProc('tasks.submit', { taskId: taskId2, body: RUN_STATUS.DONE }));
    await asEmp('peer', () => callProc('tasks.reject', { taskId: taskId2 }));
    expect((await getTask(taskId)).status).toBe(STATUS.cancelled);
    const revs = (await callProc('tasks.reviews', { taskId })) as Array<{ status: string; note: string }>;
    expect(revs[0].status).toBe(PROPOSAL_STATUS.REJECTED);
    expect(revs[0].note).toContain('wrong scope');
  });

  it('inbox lists tasks pending on me with counts', async () => {
    const a = await mkTask({ title: 'A', assigneeId: idMap.get('worker')!, ownerId: idMap.get('peer')! });
    const b = await mkTask({ title: 'B', assigneeId: idMap.get('worker')!, ownerId: idMap.get('peer')! });
    for (const id of [a, b]) {
      await setStatus(id, STATUS.doing);
      await asEmp('worker', () => callProc('tasks.ask', { taskId: id, body: 'q' }));
    }
    let inbox!: { items: unknown[]; counts: Record<string, unknown> };
    await asEmp('peer', async () => {
      inbox = await callProc('tasks.inbox');
    });
    expect(inbox.items.length).toBe(2);
    expect(inbox.counts).toEqual({ ANSWER: 2 });
  });
});

describe('assignee history', () => {
  it('create, update, and reassign all append to the ledger; current stays denormalized', async () => {
    const taskId = await mkTask({ title: 'H', assigneeId: idMap.get('worker')! });
    expect((await dbRow('taskAssignments', (await listIds(taskId))[0]!)) && (await listIds(taskId)).length).toBe(1);

    await callProc('tasks.update', { id: taskId, assigneeId: idMap.get('peer')! });
    let ids = await listIds(taskId);
    expect(ids.length).toBe(2);
    expect((await getTask(taskId)).assigneeId).toBe(idMap.get('peer')!);

    const hist = await callProc('tasks.assignments', { taskId });
    expect(hist.items.length).toBe(2);
    expect(hist.items[0].employeeName).toBe('Peer Person');
    expect(hist.items[1].employeeName).toBe('Worker');
    expect(hist.items[1].endedAt).toBeTruthy();
  });

  async function listIds(taskId: string) {
    const rows = (await callProc('tasks.assignments', { taskId })) as { items: Array<{ id: string }> };
    return rows.items.map((i) => i.id);
  }
});

describe('subtask gating', () => {
  it('parent auto-blocks while children are open and restores when all are terminal', async () => {
    const parentId = await mkTask({ title: 'Parent', assigneeId: idMap.get('worker')! });
    await setStatus(parentId, STATUS.doing);
    const c1 = await mkTask({ title: 'C1', parentId, assigneeId: idMap.get('peer')! });
    expect((await getTask(parentId)).status).toBe(STATUS.blocked);
    expect((await getTask(parentId)).preBlockStatus).toBe(STATUS.doing);

    await setStatus(c1, STATUS.doing);
    await setStatus(c1, STATUS.done);
    expect((await getTask(parentId)).status).toBe(STATUS.doing);
    expect((await getTask(parentId)).preBlockStatus).toBeNull();

    // second round: cancelled counts as terminal again (done was arm one)
    const c2 = await mkTask({ title: 'C2', parentId });
    expect((await getTask(parentId)).status).toBe(STATUS.blocked);
    await setStatus(c2, STATUS.cancelled);
    expect((await getTask(parentId)).status).toBe(STATUS.doing);
  });

  it('recursive: grandchild keeps the child (and parent) blocked', async () => {
    const root = await mkTask({ title: 'Root' });
    const mid = await mkTask({ title: 'Mid', parentId: root });
    expect((await getTask(root)).status).toBe(STATUS.blocked);
    await setStatus(mid, STATUS.doing);
    const leaf = await mkTask({ title: 'Leaf', parentId: mid });
    expect((await getTask(mid)).status).toBe(STATUS.blocked);

    await setStatus(leaf, STATUS.doing);
    await setStatus(leaf, STATUS.done);
    expect((await getTask(mid)).status).toBe(STATUS.doing);
    await setStatus(mid, STATUS.done);
    expect((await getTask(root)).status).toBe(STATUS.todo);
  });

  it('submit is refused while children are open; subtasks proc lists children', async () => {
    const parentId = await mkTask({ title: 'P2', assigneeId: idMap.get('worker')! });
    await setStatus(parentId, STATUS.doing);
    // a raw child row (no router hook) keeps the parent STATUS.doing so the explicit
    // open-children submit guard is reachable — defense in depth for racing flips
    const { db } = await import('#server/db');
    const { tasks: tasksTable } = await import('#server/db/schema');
    await db.insert(tasksTable).values({
      id: 'c-raw',
      title: 'Open child',
      description: '',
      status: STATUS.todo,
      assigneeId: null,
      ownerId: null,
      reviewers: [],
      parentTaskId: parentId,
      createdBy: null,
    });
    await expect(asEmp('worker', () => callProc('tasks.submit', { taskId: parentId, body: 'x' }))).rejects.toThrow(
      /open subtasks/i,
    );
    const c1 = 'c-raw';

    await setStatus(c1, STATUS.cancelled);
    await asEmp('worker', async () => {
      expect(await callProc('tasks.submit', { taskId: parentId, body: 'x' })).toBeTruthy();
    });
    const st = (await callProc('tasks.subtasks', { taskId: parentId })) as { items: Array<{ title: string }> };
    expect(st.items.map((i) => i.title)).toEqual(['Open child']);
  });
});

describe('proposal confirm flow', () => {
  it('subtasks: within-chain assignee kept; outside-chain escalated to supervisor', async () => {
    const taskId = await mkTask({ title: 'T1', assigneeId: idMap.get('worker')! });
    // worker's chain: chief (above), peer+report (below). 'Solo Person' is unrelated => escalation.
    const pid = await mkProposal(taskId, PROPOSAL_KIND.SUBTASKS, {
      items: [
        { title: 'In chain', description: 'd1', assigneeName: 'Peer Person' },
        { title: 'Outside chain', description: 'd2', assigneeName: 'Solo Person' },
      ],
    });
    await callProc('tasks.confirmProposal', { proposalId: pid });
    const st = (await callProc('tasks.subtasks', { taskId })) as {
      items: Array<{ title: string; assigneeId: string | null }>;
    };
    expect(st.items.length).toBe(2);
    const byTitle = new Map(st.items.map((i) => [i.title, i] as const));
    expect(byTitle.get('In chain')!.assigneeId).toBe(idMap.get('peer')!);
    // outside worker's chain -> escalates to worker's supervisor (chief)
    expect(byTitle.get('Outside chain')!.assigneeId).toBe(idMap.get('chief')!);
    // parent auto-blocked now
    expect((await getTask(taskId)).status).toBe(STATUS.blocked);
    const done = await dbRow('taskProposals', pid);
    expect(done.status).toBe(PROPOSAL_STATUS.EXECUTED);
  });

  it('subtasks: assignee names that do not exist land unassigned', async () => {
    const taskId = await mkTask({ title: 'T2', assigneeId: idMap.get('worker')! });
    const pid = await mkProposal(taskId, PROPOSAL_KIND.SUBTASKS, { items: [{ title: 'No name' }] });
    await callProc('tasks.confirmProposal', { proposalId: pid });
    const st = (await callProc('tasks.subtasks', { taskId })) as { items: Array<{ assigneeId: string | null }> };
    expect(st.items[0].assigneeId).toBeNull();
  });

  it('reassign: within chain goes through with history; ping-pong refused', async () => {
    const taskId = await mkTask({ title: 'T3', assigneeId: idMap.get('worker')! });
    const pid = await mkProposal(taskId, PROPOSAL_KIND.REASSIGN, { targetName: 'Peer Person', reason: 'their domain' });
    await callProc('tasks.confirmProposal', { proposalId: pid });
    expect((await getTask(taskId)).assigneeId).toBe(idMap.get('peer')!);
    expect(await recentAssignees(taskId, 2)).toContain(idMap.get('peer')!);

    // peer is now assignee; proposing reassign BACK to worker (recent) is refused
    const back = await mkProposal(taskId, PROPOSAL_KIND.REASSIGN, { targetName: 'Worker', reason: 'back' });
    await expect(callProc('tasks.confirmProposal', { proposalId: back })).rejects.toThrow(/loop guard/i);
  });

  it('reassign: unknown employee rejected; double-confirm rejected; reject keeps task and rides the brief', async () => {
    const taskId = await mkTask({ title: 'T4', assigneeId: idMap.get('worker')! });
    const bad = await mkProposal(taskId, PROPOSAL_KIND.REASSIGN, { targetName: 'Ghost', reason: 'x' });
    await expect(callProc('tasks.confirmProposal', { proposalId: bad })).rejects.toThrow(/not found/i);

    const pid = await mkProposal(taskId, PROPOSAL_KIND.REASSIGN, { targetName: 'Peer Person', reason: 'r' });
    await callProc('tasks.rejectProposal', { proposalId: pid, note: 'stay on it' });
    expect((await dbRow('taskProposals', pid)).status).toBe(PROPOSAL_STATUS.REJECTED);
    // decided proposals cannot be confirmed
    await expect(callProc('tasks.confirmProposal', { proposalId: pid })).rejects.toThrow(/already decided/i);

    const { loadBriefData, buildBrief } = await import('#server/domains/tasks/brief.service');
    const data = await loadBriefData(taskId);
    const brief = buildBrief(data);
    expect(brief).toContain('proposal declined');
    expect(brief).toContain('stay on it');
  });

  it('double-confirm is idempotent: second throws, one child set', async () => {
    const taskId = await mkTask({ title: 'Idem2', assigneeId: idMap.get('worker')! });
    const pid = await mkProposal(taskId, PROPOSAL_KIND.SUBTASKS, {
      items: [{ title: 'Once', assigneeName: 'Peer Person' }],
    });
    await callProc('tasks.confirmProposal', { proposalId: pid });
    await expect(callProc('tasks.confirmProposal', { proposalId: pid })).rejects.toThrow(/already decided/i);
    const st = (await callProc('tasks.subtasks', { taskId })) as { items: Array<{ title: string }> };
    expect(st.items.map((i) => i.title)).toEqual(['Once']);
    // the claim rolled nothing back: the proposal still reads EXECUTED
    expect((await dbRow('taskProposals', pid)).status).toBe(PROPOSAL_STATUS.EXECUTED);
  });

  it('concurrent confirms race the claim: exactly one wins, one child set', async () => {
    const taskId = await mkTask({ title: 'IdemRace', assigneeId: idMap.get('worker')! });
    const pid = await mkProposal(taskId, PROPOSAL_KIND.SUBTASKS, {
      items: [{ title: 'Solo child', assigneeName: 'Peer Person' }],
    });
    const { confirmProposal } = await import('#server/domains/tasks/proposals.service');
    const adminId = idMap.get('chief')!;
    const results = await Promise.allSettled([confirmProposal(pid, adminId), confirmProposal(pid, adminId)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const st = (await callProc('tasks.subtasks', { taskId })) as { items: Array<{ title: string }> };
    expect(st.items.map((i) => i.title)).toEqual(['Solo child']);
  });

  it('rejected reassign keeps the current assignee', async () => {
    const taskId = await mkTask({ title: 'T5', assigneeId: idMap.get('worker')! });
    const pid = await mkProposal(taskId, PROPOSAL_KIND.REASSIGN, { targetName: 'Peer Person', reason: 'r' });
    await callProc('tasks.rejectProposal', { proposalId: pid });
    expect((await getTask(taskId)).assigneeId).toBe(idMap.get('worker')!);
  });
});

describe('routing coverage arms', () => {
  it('tasks.proposals lists stored proposals; create with bad parentId rejected', async () => {
    await expect(mkTask({ title: 'X', parentId: 'nope' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const taskId = await mkTask({ title: 'Cov', assigneeId: idMap.get('worker')! });
    // outside-chain target stays proposed (the list still surfaces proposals)
    await recordProposals(taskId, null as unknown as string, idMap.get('worker')!, [
      { kind: PROPOSAL_KIND.SUBTASKS, items: [{ title: 'Only', description: 'd', assigneeName: 'Solo Person' }] },
    ]);
    const list = await callProc('tasks.proposals', { taskId });
    expect(list.items.length).toBe(1);
    expect(list.items[0].kind).toBe(PROPOSAL_KIND.SUBTASKS);
    expect(list.items[0].status).toBe('proposed'); // response mapping lowercases the stored enum
  });

  it('reassign escalation: outside-chain target lands on the agent supervisor', async () => {
    const taskId = await mkTask({ title: 'Esc', assigneeId: idMap.get('worker')!, ownerId: idMap.get('chief')! });
    // Solo Person is outside worker's chain (chief above, peer/report below)
    const pid = await mkProposal(taskId, PROPOSAL_KIND.REASSIGN, {
      targetName: 'Solo Person',
      reason: 'their specialty',
    });
    await callProc('tasks.confirmProposal', { proposalId: pid });
    expect((await getTask(taskId)).assigneeId).toBe(idMap.get('chief')!);
    const hist = await callProc('tasks.assignments', { taskId });
    expect(hist.items[0].reason).toContain('escalated');
  });

  it('reassign on an unassigned task writes through directly', async () => {
    const taskId = await mkTask({ title: 'Unassigned' });
    const pid = await mkProposal(taskId, PROPOSAL_KIND.REASSIGN, { targetName: 'Peer Person' });
    await callProc('tasks.confirmProposal', { proposalId: pid });
    expect((await getTask(taskId)).assigneeId).toBe(idMap.get('peer')!);
  });

  it('reassign without a reason still records', async () => {
    const taskId = await mkTask({ title: 'NoReason', assigneeId: idMap.get('worker')! });
    const pid = await mkProposal(taskId, PROPOSAL_KIND.REASSIGN, { targetName: 'Peer Person' });
    await callProc('tasks.confirmProposal', { proposalId: pid });
    const hist = await callProc('tasks.assignments', { taskId });
    expect(hist.items[0].reason).toBe('reassign: ');
  });

  it('spawnObligation is idempotent for identical pending rows', async () => {
    const taskId = await mkTask({ title: 'Idem' });
    const a = await spawnObligation(taskId, idMap.get('peer')!, OBLIGATION_ROLE.ANSWER);
    const b = await spawnObligation(taskId, idMap.get('peer')!, OBLIGATION_ROLE.ANSWER);
    expect(a).toBe(b);
  });

  it('pendingCounts splits by role; openObligations batches holders and approvers', async () => {
    const a = await mkTask({ title: 'MultiA', assigneeId: idMap.get('worker')!, ownerId: idMap.get('peer')! });
    const b = await mkTask({ title: 'MultiB', assigneeId: idMap.get('worker')!, reviewers: [idMap.get('peer')!] });
    await setStatus(a, STATUS.doing);
    await asEmp('worker', () => callProc('tasks.ask', { taskId: a, body: 'q' }));
    await setStatus(b, STATUS.doing);
    await asEmp('worker', () => callProc('tasks.submit', { taskId: b, body: 's' }));
    let counts!: { counts: Record<string, unknown> };
    await asEmp('peer', async () => {
      counts = await callProc('tasks.inbox');
    });
    expect(counts.counts).toEqual({ ANSWER: 1, APPROVAL: 1 });

    const open = await openObligations([a, b]);
    expect(open.get(a)!.holders).toEqual([idMap.get('peer')!]);
    expect(open.get(b)!.approvers).toEqual([idMap.get('peer')!]);
    expect(await openObligations([])).toBeInstanceOf(Map);

    const approvals = await approvalsInRoundBatch([b]);
    expect(approvals.get(b)).toEqual([]);
  });

  it('buildBrief renders parent context for children and omits it for roots', async () => {
    const { loadBriefData, buildBrief } = await import('#server/domains/tasks/brief.service');
    const root = await mkTask({ title: 'Root task', assigneeId: idMap.get('worker')! });
    const child = await mkTask({ title: 'Child task', parentId: root, assigneeId: idMap.get('peer')! });
    const childBrief = buildBrief(await loadBriefData(child));
    expect(childBrief).toContain('This is a subtask of: Root task');
    // routing folded into the JSON envelope: the contract shows the optional fields
    expect(childBrief).toContain('"subtasks"');
    expect(childBrief).toContain('"reassign"');
    expect(childBrief).not.toContain('[SUBTASKS]');
    expect(childBrief).not.toContain('[REASSIGN]');
    const rootBrief = buildBrief({
      ...(await loadBriefData(root)),
      task: { ...(await loadBriefData(root)).task, parentTitle: null },
    });
    expect(rootBrief).not.toContain('This is a subtask of');
  });

  it('parser: empty segments become undefined; multiple items; reassign without reason', () => {
    expect(parseRoutingProposals('[SUBTASKS] A :: :: Peer Person')).toEqual([
      { kind: PROPOSAL_KIND.SUBTASKS, items: [{ title: 'A', description: undefined, assigneeName: 'Peer Person' }] },
    ]);
    expect(parseRoutingProposals('[SUBTASKS] B')).toEqual([
      { kind: PROPOSAL_KIND.SUBTASKS, items: [{ title: 'B', description: undefined, assigneeName: undefined }] },
    ]);
  });
});

describe('routing coverage arms II', () => {
  it('approvalsInRoundBatch on a task with no review history is empty; cancelled rounds read empty', async () => {
    const fresh = await mkTask({ title: 'Fresh' });
    // no approval obligations at all -> the map simply has no entry for the task
    expect((await approvalsInRoundBatch([fresh])).get(fresh) ?? []).toEqual([]);

    const taskId = await mkTask({
      title: 'RoundTrip',
      assigneeId: idMap.get('worker')!,
      reviewers: [idMap.get('peer')!],
    });
    await setStatus(taskId, STATUS.doing);
    await asEmp('worker', () => callProc('tasks.submit', { taskId, body: 'v1' }));
    await asEmp('peer', () => callProc('tasks.requestChanges', { taskId, body: 'no' }));
    const batch = await approvalsInRoundBatch([taskId]);
    expect(batch.get(taskId)).toEqual([]);
  });

  it('confirm/reject guard unknown ids, decided rows, and vanished tasks', async () => {
    await expect(callProc('tasks.confirmProposal', { proposalId: 'ghost' })).rejects.toThrow(/not found/i);
    await expect(callProc('tasks.rejectProposal', { proposalId: 'ghost' })).rejects.toThrow(/not found/i);

    const taskId = await mkTask({ title: 'Gone', assigneeId: idMap.get('worker')! });
    const pid = await mkProposal(taskId, PROPOSAL_KIND.REASSIGN, { targetName: 'Peer Person', reason: 'r' });
    await callProc('tasks.rejectProposal', { proposalId: pid });
    await expect(callProc('tasks.rejectProposal', { proposalId: pid })).rejects.toThrow(/already decided/i);
  });

  it('confirm refuses unknown proposal kinds', async () => {
    const taskId = await mkTask({ title: 'Kindless', assigneeId: idMap.get('worker')! });
    const pid = await mkProposal(taskId, 'nonsense', {});
    await expect(callProc('tasks.confirmProposal', { proposalId: pid })).rejects.toThrow(/unknown proposal kind/i);
  });

  it('reassign outside chain with no supervisor falls through to the loop guard / direct write', async () => {
    // solo has no supervisor: escalation block skipped entirely
    const taskId = await mkTask({ title: 'Lonely', assigneeId: idMap.get('solo')! });
    const pid = await mkProposal(taskId, PROPOSAL_KIND.REASSIGN, { targetName: 'Peer Person', reason: 'help' });
    await callProc('tasks.confirmProposal', { proposalId: pid });
    expect((await getTask(taskId)).assigneeId).toBe(idMap.get('peer')!);
  });

  it('reassign to the supervisor itself skips the escalation write but still lands on the supervisor', async () => {
    const taskId = await mkTask({ title: 'ToSup', assigneeId: idMap.get('worker')! });
    const pid = await mkProposal(taskId, PROPOSAL_KIND.REASSIGN, { targetName: 'Chief Person', reason: 'above me' });
    await callProc('tasks.confirmProposal', { proposalId: pid });
    expect((await getTask(taskId)).assigneeId).toBe(idMap.get('chief')!);
  });

  it('subtasks proposal with no items executes as a no-op; owner fallbacks cover cleared owners', async () => {
    const taskId = await mkTask({ title: 'NoItems', assigneeId: idMap.get('worker')! });
    const pid = await mkProposal(taskId, PROPOSAL_KIND.SUBTASKS, {});
    await callProc('tasks.confirmProposal', { proposalId: pid });
    const st = await callProc('tasks.subtasks', { taskId });
    expect(st.items.length).toBe(0);

    // escalation with NO supervisor (solo) falls back to the task owner
    const owned = await mkTask({ title: 'OwnFall', assigneeId: idMap.get('solo')!, ownerId: idMap.get('chief')! });
    const oid = await mkProposal(owned, PROPOSAL_KIND.SUBTASKS, {
      items: [{ title: 'Far', assigneeName: 'Peer Person' }],
    });
    await callProc('tasks.confirmProposal', { proposalId: oid });
    const st2 = await callProc('tasks.subtasks', { taskId: owned });
    expect(st2.items[0].assigneeId).toBe(idMap.get('chief')!);

    // owner cleared entirely -> createdBy fallback
    const { db } = await import('#server/db');
    const { tasks: tasksTable } = await import('#server/db/schema');
    const createdBy = await db.update(tasksTable).set({ ownerId: null }).where(eq(tasksTable.id, owned)).returning();
    expect(createdBy.length).toBe(1);
    const cid = await mkProposal(owned, PROPOSAL_KIND.SUBTASKS, {
      items: [{ title: 'Far2', assigneeName: 'Report Guy' }],
    });
    await callProc('tasks.confirmProposal', { proposalId: cid });
    const st3 = (await callProc('tasks.subtasks', { taskId: owned })) as { items: Array<{ title: string }> };
    expect(st3.items.map((i) => i.title)).toContain('Far2');
  });

  it('escalated reassign without a reason still executes', async () => {
    const taskId = await mkTask({ title: 'EscNoReason', assigneeId: idMap.get('worker')! });
    const pid = await mkProposal(taskId, PROPOSAL_KIND.REASSIGN, { targetName: 'Solo Person' });
    await callProc('tasks.confirmProposal', { proposalId: pid });
    expect((await getTask(taskId)).assigneeId).toBe(idMap.get('chief')!);
    const hist = await callProc('tasks.assignments', { taskId });
    expect(hist.items[0].reason).toContain('reassign:');
  });

  it('AUTO-LAW: routing to own chain executes without approval; outside stays proposed', async () => {
    // worker's chain includes Peer Person; Solo Person is outside
    const taskId = await mkTask({ title: 'AutoExec', assigneeId: idMap.get('worker')! });
    await recordProposals(taskId, null as unknown as string, idMap.get('worker')!, [
      {
        kind: PROPOSAL_KIND.SUBTASKS,
        items: [{ title: 'Mine to Peer', description: 'd', assigneeName: 'Peer Person' }],
      },
    ]);
    let rows = (await dbRows('taskProposals')).filter((p) => p.taskId === taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(PROPOSAL_STATUS.EXECUTED); // no human touched it
    const st = await callProc('tasks.subtasks', { taskId });
    expect(st.items[0].title).toBe('Mine to Peer');
    expect(st.items[0].assigneeId).toBe(idMap.get('peer')!);

    // outside the chain -> still a proposal awaiting a human
    const taskId2 = await mkTask({ title: 'AutoKeep', assigneeId: idMap.get('worker')! });
    await recordProposals(taskId2, null as unknown as string, idMap.get('worker')!, [
      { kind: PROPOSAL_KIND.SUBTASKS, items: [{ title: 'Out', description: 'd', assigneeName: 'Solo Person' }] },
    ]);
    rows = (await dbRows('taskProposals')).filter((p) => p.taskId === taskId2);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(PROPOSAL_STATUS.PROPOSED);
  });

  it('AUTO-LAW: in-chain reassign executes immediately; loop-guard target stays proposed (no throw)', async () => {
    const taskId = await mkTask({ title: 'AutoRe', assigneeId: idMap.get('worker')! });
    await recordProposals(taskId, null as unknown as string, idMap.get('worker')!, [
      { kind: PROPOSAL_KIND.REASSIGN, targetName: 'Peer Person', reason: 'their domain' },
    ]);
    expect((await getTask(taskId)).assigneeId).toBe(idMap.get('peer')!);
    const rows = (await dbRows('taskProposals')).filter((p) => p.taskId === taskId);
    expect(rows[0].status).toBe(PROPOSAL_STATUS.EXECUTED);

    // peer is now the assignee; routing BACK to worker (recent) trips the loop guard -> stays proposed
    await recordProposals(taskId, null as unknown as string, idMap.get('worker')!, [
      { kind: PROPOSAL_KIND.REASSIGN, targetName: 'Worker', reason: 'back' },
    ]);
    const back = (await dbRows('taskProposals')).filter(
      (p) => p.taskId === taskId && p.status === PROPOSAL_STATUS.PROPOSED,
    );
    expect(back).toHaveLength(1);
  });

  it('recordProposals reassign summary includes the reason', async () => {
    const taskId = await mkTask({ title: 'ReasonSum' });
    // author with no supervision chain: the gate stays closed so the proposed-summary path runs
    await recordProposals(taskId, null as unknown as string, idMap.get('solo')!, [
      { kind: PROPOSAL_KIND.REASSIGN, targetName: 'Peer Person', reason: 'legal work' },
    ]);
    const { db } = await import('#server/db');
    const { taskActivity } = await import('#server/db/schema');
    const acts = await db.select().from(taskActivity);
    expect(acts.some((a) => a.body!.includes('legal work'))).toBe(true);
  });

  it('item budget: recordProposals drops a >20-item payload (no row, no execution)', async () => {
    const taskId = await mkTask({ title: 'TooMany', assigneeId: idMap.get('worker')! });
    const items = Array.from({ length: 21 }, (_, i) => ({ title: `Bulk ${i + 1}` }));
    await recordProposals(taskId, null as unknown as string, idMap.get('worker')!, [
      { kind: PROPOSAL_KIND.SUBTASKS, items },
    ]);
    expect((await dbRows('taskProposals')).filter((p) => p.taskId === taskId)).toHaveLength(0);
    expect((await getTask(taskId)).status).toBe(STATUS.todo); // nothing executed either
  });

  it('live payload skips holders for approval-only tasks (in-review snapshot)', async () => {
    const taskId = await mkTask({
      title: 'ApproveOnly',
      assigneeId: idMap.get('worker')!,
      reviewers: [idMap.get('peer')!],
    });
    await setStatus(taskId, STATUS.doing);
    await asEmp('worker', () => callProc('tasks.submit', { taskId, body: 's' }));
    const iter = await callProc('tasks.live');
    const snap = await iter.next();
    const rows = (snap.value as { rows?: TaskRow[] }).rows ?? (snap.value as TaskRow[]);
    const mine = rows.find((r) => r.id === taskId)!;
    expect(mine.questionHolderId).toBeNull();
    expect(mine.reviewApprovals).toEqual([]);
    await iter.return?.();
  });

  it('recordProposals logs a reassign summary without reason; live payload exposes holder and approvals', async () => {
    const taskId = await mkTask({
      title: 'Live',
      assigneeId: idMap.get('worker')!,
      ownerId: idMap.get('peer')!,
      reviewers: [idMap.get('report')!],
    });
    // outside-chain target: stays proposed (in-chain routing auto-executes by law and would move the assignee)
    await recordProposals(taskId, null as unknown as string, idMap.get('worker')!, [
      { kind: PROPOSAL_KIND.REASSIGN, targetName: 'Solo Person' },
    ]);

    await setStatus(taskId, STATUS.doing);
    await asEmp('worker', () => callProc('tasks.ask', { taskId, body: 'q' }));
    await asEmp('peer', () => callProc('tasks.answer', { taskId, body: 'a' }));
    await setStatus(taskId, STATUS.doing);
    await asEmp('worker', () => callProc('tasks.submit', { taskId, body: 's' }));
    await asEmp('report', () => callProc('tasks.approve', { taskId, body: 'ok' }));

    const iter = await callProc('tasks.live');
    const snap = await iter.next();
    const rows = (snap.value as { rows?: TaskRow[] }).rows ?? (snap.value as TaskRow[]);
    const mine = rows.find((r) => r.id === taskId)!;
    expect(mine.reviewApprovals).toEqual([idMap.get('report')!]);
    expect(mine.parentTaskId).toBeNull();
    await iter.return?.();
  });

  it('assignment with a null employee renders an unnamed ledger row', async () => {
    const taskId = await mkTask({ title: 'NullAssign', assigneeId: idMap.get('peer')! });
    await callProc('tasks.update', { id: taskId, assigneeId: null });
    const hist = await callProc('tasks.assignments', { taskId });
    expect(hist.items[0].employeeName).toBeNull();
    expect(hist.items[0].endedAt).toBeNull();
    expect(hist.items[1].endedAt).toBeTruthy();
  });
});
