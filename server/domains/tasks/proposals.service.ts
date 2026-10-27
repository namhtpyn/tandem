import { consola } from 'consola';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { CHANGE_RESOURCE, CHANGE_ACTION, PROPOSAL_STATUS, PROPOSAL_KIND, ACTIVITY_KIND } from '#shared/enums';
import { STATUS } from '#shared/status';
// Proposal executor — confirms agent [SUBTASKS] / [REASSIGN] proposals and acts on them.
// The confirm side is the single writer for structural changes (user law, 2026-10-15):
// agents propose, this service executes after a human (or the future decision model) confirms.
// Escalation law: an agent may only nominate within its own supervision chain (self,
// its reports up/down); anything else escalates to the agent's supervisor.
// Reassign loop guard: refuse targets who held the ticket recently (assignee history).
import { nonNull } from '#shared/utils/non-null';

import { db, asDb, type DbExecutor } from '../../db/index';
import { tasks, taskProposals, user as userTable, employeeSupervisors } from '../../db/schema';
import { publishChange } from '../kernel/kernel';
import { recordAssignment, recentAssignees, assignTask } from './assignments.service';
import { refreshParentGating } from './gating.service';
import { logActivity as publishActivity } from './review.service';

export type SubtaskItem = { title: string; description?: string; assigneeName?: string };
export type ProposalPayload =
  | { kind: typeof PROPOSAL_KIND.SUBTASKS; items: SubtaskItem[] }
  | { kind: typeof PROPOSAL_KIND.REASSIGN; targetName?: string; reason?: string };

const log = consola.withTag('tandem');

/** the agent's own supervision chain: self + everyone above + everyone below (direct+indirect) */
export async function supervisionChain(employeeId: string, ex: DbExecutor = db) {
  const d = asDb(ex);
  const chain = new Set<string>([employeeId]);
  // up
  let frontier = [employeeId];
  while (frontier.length) {
    const sup = await d
      .select({ supervisorId: employeeSupervisors.supervisorId })
      .from(employeeSupervisors)
      .where(inArray(employeeSupervisors.employeeId, frontier));
    frontier = sup.map((s) => s.supervisorId).filter((id) => !chain.has(id));
    for (const id of frontier) chain.add(id);
  }
  // down
  frontier = [employeeId];
  while (frontier.length) {
    const rep = await d
      .select({ employeeId: employeeSupervisors.employeeId })
      .from(employeeSupervisors)
      .where(inArray(employeeSupervisors.supervisorId, frontier));
    frontier = rep.map((r) => r.employeeId).filter((id) => !chain.has(id));
    for (const id of frontier) chain.add(id);
  }
  return chain;
}

async function firstSupervisor(employeeId: string, ex: DbExecutor = db) {
  const rows = await asDb(ex)
    .select({ supervisorId: employeeSupervisors.supervisorId })
    .from(employeeSupervisors)
    .where(eq(employeeSupervisors.employeeId, employeeId));
  return rows[0]?.supervisorId ?? null;
}

async function findByName(name: string | undefined, ex: DbExecutor = db) {
  if (!name) return null;
  const rows = await asDb(ex)
    .select({ id: userTable.id, name: userTable.name })
    .from(userTable)
    .where(eq(userTable.name, name))
    // duplicate names are allowed: oldest account wins so resolution is deterministic
    .orderBy(asc(userTable.createdAt));
  return rows[0] ?? null;
}

async function logActivity(
  taskId: string,
  authorId: string | null,
  body: string,
  meta: Record<string, unknown> = {},
  ex: DbExecutor = db,
) {
  await publishActivity(taskId, ACTIVITY_KIND.NOTE, authorId, body, meta, ex);
  await publishChange(CHANGE_RESOURCE.TASK_ACTIVITY, CHANGE_ACTION.CREATE);
  await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
}

/** the slice of the task row the confirm flow touches */
type ConfirmTask = { id: string; ownerId: string | null; createdBy: string | null; assigneeId: string | null };

/** resolve a proposed assignee: inside the agent's chain -> as proposed, outside -> its supervisor */
async function resolveAssignee(item: SubtaskItem, task: ConfirmTask, events: string[], ex: DbExecutor) {
  const proposed = await findByName(item.assigneeName, ex);
  if (!proposed || !task.assigneeId) return { assigneeId: null, escalated: false };
  const chain = await supervisionChain(task.assigneeId, ex);
  if (chain.has(proposed.id)) return { assigneeId: proposed.id, escalated: false };
  events.push(`"${item.assigneeName}" is outside ${'the agent'}'s chain → escalated to supervisor`);
  const supervisor = (await firstSupervisor(task.assigneeId, ex)) ?? task.ownerId ?? task.createdBy;
  return { assigneeId: supervisor, escalated: true };
}

/** create one child task from a proposed subtask */
async function createSubtask(
  task: ConfirmTask,
  item: SubtaskItem,
  assigneeId: string | null,
  confirmedBy: string,
  ex: DbExecutor,
) {
  const childId = uuidv7();
  await asDb(ex)
    .insert(tasks)
    .values({
      id: childId,
      title: item.title.slice(0, 200),
      // agent-proposed text gets the same 2000-char cap as a human note
      description: item.description?.slice(0, 2000) ?? '',
      status: STATUS.todo,
      assigneeId,
      ownerId: task.ownerId ?? task.createdBy,
      reviewers: [],
      parentTaskId: task.id,
      createdBy: confirmedBy,
    });
  return childId;
}

/** execute every [SUBTASKS] item, then refresh the parent's gating */
async function executeSubtasks(
  task: ConfirmTask,
  payload: { items?: SubtaskItem[] },
  confirmedBy: string,
  events: string[],
  ex: DbExecutor,
) {
  for (const item of payload.items ?? []) {
    const { assigneeId, escalated } = await resolveAssignee(item, task, events, ex);
    const childId = await createSubtask(task, item, assigneeId, confirmedBy, ex);
    if (assigneeId)
      await recordAssignment(childId, assigneeId, escalated ? 'subtask-escalated' : 'subtask', confirmedBy, ex);
    events.push(`subtask "${item.title}" → ${escalated ? 'supervisor' : (item.assigneeName ?? 'unassigned')}`);
    await logActivity(
      task.id,
      confirmedBy,
      `subtask created: ${item.title}${escalated ? ' (escalated)' : ''}`,
      {
        childId,
      },
      ex,
    );
  }
  await refreshParentGating(task.id, ex);
}

/** reassign through the ledger so the history stays truthful */
async function doReassign(
  taskId: string,
  employeeId: string,
  actorId: string | null,
  reason: string,
  extra = '',
  ex: DbExecutor = db,
) {
  await assignTask(taskId, employeeId, `reassign: ${reason}${extra ? ` (${extra})` : ''}`, actorId, ex);
  const name = nonNull(
    await asDb(ex).query.user.findFirst({ columns: { name: true }, where: { id: { eq: employeeId } } }),
  ).name;
  await logActivity(
    taskId,
    actorId,
    `reassigned to ${name}${extra ? ` (${extra})` : ''}`,
    {
      reassign: true,
      reason,
    },
    ex,
  );
}

async function escalateReassignToSupervisor(
  task: ConfirmTask,
  target: { id: string },
  targetName: string | undefined,
  reason: string,
  confirmedBy: string,
  events: string[],
  ex: DbExecutor,
) {
  if (!task.assigneeId) return false;
  const chain = await supervisionChain(task.assigneeId, ex);
  if (chain.has(target.id)) return false;
  const sup = await firstSupervisor(task.assigneeId, ex);
  if (!sup) return false;
  events.push(`target outside the agent's chain → escalated to supervisor`);
  await doReassign(task.id, sup, confirmedBy, reason, `escalated from ${targetName}`, ex);
  return true;
}

/**
 * Confirm a proposal: the claim, the side effects and the decision note run in ONE
 * transaction. The claim is a conditional UPDATE (status must still be PROPOSED) —
 * 0 rows means a concurrent decision won, the whole transaction rolls back and the
 * caller sees 'proposal already decided', so nothing executes twice.
 */
export async function confirmProposal(proposalId: string, confirmedBy: string, note = '') {
  const result = await db.transaction(async (tx) => {
    const rows = await tx.query.taskProposals.findMany({
      columns: { taskId: true, kind: true, payload: true, status: true },
      where: { id: { eq: proposalId } },
      orderBy: { createdAt: 'asc' },
    });
    const p = rows[0];
    if (!p) throw new Error('proposal not found');
    if (p.status !== PROPOSAL_STATUS.PROPOSED) throw new Error('proposal already decided');
    // claim BEFORE any side effect: a concurrent confirm/reject gets 0 rows here
    const claimed = await tx
      .update(taskProposals)
      .set({ status: PROPOSAL_STATUS.EXECUTED, decidedBy: confirmedBy, decidedAt: new Date() })
      .where(and(eq(taskProposals.id, proposalId), eq(taskProposals.status, PROPOSAL_STATUS.PROPOSED)))
      .returning({ id: taskProposals.id });
    if (claimed.length === 0) throw new Error('proposal already decided');
    // task row is guaranteed by the proposal's FK (cascade delete removes proposals with tasks)
    const task = nonNull(
      (
        await tx.query.tasks.findMany({
          columns: { id: true, ownerId: true, createdBy: true, assigneeId: true },
          where: { id: { eq: p.taskId } },
          orderBy: { createdAt: 'asc' },
        })
      )[0],
    );

    const events: string[] = [];
    let escalated = false;
    if (p.kind === PROPOSAL_KIND.SUBTASKS) {
      await executeSubtasks(task, p.payload as { items?: SubtaskItem[] }, confirmedBy, events, tx);
    } else if (p.kind === PROPOSAL_KIND.REASSIGN) {
      const payload = p.payload as { targetName?: string; reason?: string };
      const target = await findByName(payload.targetName, tx);
      if (!target) throw new Error(`employee "${payload.targetName}" not found`);
      escalated = await escalateReassignToSupervisor(
        task,
        target,
        payload.targetName,
        payload.reason ?? '',
        confirmedBy,
        events,
        tx,
      );
      if (!escalated) {
        // loop guard: refuse a target who held the ticket recently (ping-pong)
        const recent = await recentAssignees(task.id, 2, tx);
        if (recent.includes(target.id)) throw new Error('loop guard: that person held this task recently');
        await doReassign(task.id, target.id, confirmedBy, payload.reason ?? '', '', tx);
        events.push(`reassigned to ${payload.targetName}`);
      }
    } else throw new Error(`unknown proposal kind ${p.kind}`);

    const summary = escalated ? [...events, `reassigned to supervisor (escalation)`].join('; ') : events.join('; ');
    await tx
      .update(taskProposals)
      .set({ decisionNote: note || summary })
      .where(eq(taskProposals.id, proposalId));
    return { ok: true, events };
  });
  // publish after commit so live readers never re-query mid-transaction
  await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
  return result;
}

/** reject a proposal: the conditional UPDATE is the decision — 0 rows means already decided */
export async function rejectProposal(proposalId: string, decidedBy: string, note = '') {
  const result = await db.transaction(async (tx) => {
    const rows = await tx.query.taskProposals.findMany({
      columns: { taskId: true, kind: true },
      where: { id: { eq: proposalId } },
      orderBy: { createdAt: 'asc' },
    });
    const p = rows[0];
    if (!p) throw new Error('proposal not found');
    const claimed = await tx
      .update(taskProposals)
      .set({ status: PROPOSAL_STATUS.REJECTED, decidedBy, decidedAt: new Date(), decisionNote: note })
      .where(and(eq(taskProposals.id, proposalId), eq(taskProposals.status, PROPOSAL_STATUS.PROPOSED)))
      .returning({ id: taskProposals.id });
    if (claimed.length === 0) throw new Error('proposal already decided');
    await logActivity(
      p.taskId,
      decidedBy,
      `proposal rejected${note ? `: ${note}` : ''}`,
      { proposalId, kind: p.kind },
      tx,
    );
    return { ok: true };
  });
  await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
  return result;
}

/** store proposals parsed from a run envelope (called by the runner on settle).
 * AUTO-EXECUTION LAW (2026-10-16): a supervisor routing work to people inside its
 * own supervision chain needs NO approval — the proposal is executed immediately
 * by the same confirm path a human would use. Anything touching people outside
 * the chain (or unnamed routing targets) still waits for a human.
 * `authorId` is the run's AGENT — the chain judged here is the author's, never the
 * task's current assignee (which can move while a run is in flight).
 * CURRENCY LAW: the task is reloaded before anything lands — a run that finished
 * on a done/cancelled task records nothing, and a run whose author is no longer
 * the assignee (reassigned mid-flight) loses the auto-execute right: its
 * proposals stay PROPOSED for a human instead of mutating the new state. */
export async function recordProposals(
  taskId: string,
  runId: string,
  authorId: string,
  payloads: Array<ProposalPayload>,
) {
  const taskRow = (
    await db.select({ status: tasks.status, assigneeId: tasks.assigneeId }).from(tasks).where(eq(tasks.id, taskId))
  )[0];
  // a terminal or vanished task takes nothing from a run that settled late
  if (!taskRow || taskRow.status === STATUS.done || taskRow.status === STATUS.cancelled) return;
  // stale author = the task moved to someone else while the run flew: no auto-execution
  const staleAuthor = taskRow.assigneeId !== null && taskRow.assigneeId !== authorId;
  const chain = await supervisionChain(authorId);
  for (const payload of payloads) {
    // item budget: a runaway [SUBTASKS] line must not spawn an unbounded child set
    if (payload.kind === PROPOSAL_KIND.SUBTASKS && payload.items.length > 20) {
      log.warn(`dropped [SUBTASKS] proposal with ${payload.items.length} items (cap 20) on task ${taskId}`);
      continue;
    }
    const proposalId = uuidv7();
    await db.insert(taskProposals).values({
      id: proposalId,
      taskId,
      runId,
      kind: payload.kind,
      payload: payload as unknown as Record<string, unknown>,
      status: PROPOSAL_STATUS.PROPOSED,
    });
    // every routing target named and inside the author's own chain -> auto-execute
    let inChain = false;
    if (chain.size > 1 && !staleAuthor) {
      if (payload.kind === PROPOSAL_KIND.REASSIGN) {
        const target = await findByName(payload.targetName);
        inChain = !!target && chain.has(target.id);
      } else {
        const targets = await Promise.all(payload.items.map(async (i) => await findByName(i.assigneeName)));
        inChain = payload.items.length > 0 && targets.every((t) => t !== null && chain.has(t.id));
      }
    }
    if (inChain) {
      try {
        const r = await confirmProposal(proposalId, authorId, 'auto: routing within own supervision chain');
        // events may be empty for degenerate payloads — the fallback text covers it
        /* v8 ignore next */
        const summary = r.events.length ? r.events.join('; ') : 'auto-executed (within chain)';
        await logActivity(taskId, authorId, `routing executed without approval — ${summary}`, {
          proposal: true,
          kind: payload.kind,
          auto: true,
        });
        continue;
      } catch {
        /* loop guard or missing target: fall through, stays proposed */
      }
    }
    const summary =
      payload.kind === PROPOSAL_KIND.SUBTASKS
        ? `proposed ${payload.items.length} subtask(s): ${payload.items.map((i) => i.title).join(', ')}`
        : `proposed reassigning to ${payload.targetName}${payload.reason ? ` — ${payload.reason}` : ''}`;
    await logActivity(taskId, null, summary, { proposal: true, kind: payload.kind });
  }
}
