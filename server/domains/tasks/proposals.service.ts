import { eq, inArray } from 'drizzle-orm';
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

import { db } from '../../db/index';
import { tasks, taskActivity, taskProposals, user as userTable, employeeSupervisors } from '../../db/schema';
import { publishChange } from '../kernel/kernel';
import { recordAssignment, recentAssignees, assignTask } from './assignments.service';
import { refreshParentGating } from './gating.service';

export type SubtaskItem = { title: string; description?: string; assigneeName?: string };
export type ProposalPayload =
  | { kind: typeof PROPOSAL_KIND.SUBTASKS; items: SubtaskItem[] }
  | { kind: typeof PROPOSAL_KIND.REASSIGN; targetName?: string; reason?: string };

/** the agent's own supervision chain: self + everyone above + everyone below (direct+indirect) */
export async function supervisionChain(employeeId: string) {
  const chain = new Set<string>([employeeId]);
  // up
  let frontier = [employeeId];
  while (frontier.length) {
    const sup = await db
      .select({ supervisorId: employeeSupervisors.supervisorId })
      .from(employeeSupervisors)
      .where(inArray(employeeSupervisors.employeeId, frontier));
    frontier = sup.map((s) => s.supervisorId).filter((id) => !chain.has(id));
    for (const id of frontier) chain.add(id);
  }
  // down
  frontier = [employeeId];
  while (frontier.length) {
    const rep = await db
      .select({ employeeId: employeeSupervisors.employeeId })
      .from(employeeSupervisors)
      .where(inArray(employeeSupervisors.supervisorId, frontier));
    frontier = rep.map((r) => r.employeeId).filter((id) => !chain.has(id));
    for (const id of frontier) chain.add(id);
  }
  return chain;
}

async function firstSupervisor(employeeId: string) {
  const rows = await db
    .select({ supervisorId: employeeSupervisors.supervisorId })
    .from(employeeSupervisors)
    .where(eq(employeeSupervisors.employeeId, employeeId));
  return rows[0]?.supervisorId ?? null;
}

async function findByName(name: string | undefined) {
  if (!name) return null;
  const rows = await db
    .select({ id: userTable.id, name: userTable.name })
    .from(userTable)
    .where(eq(userTable.name, name));
  return rows[0] ?? null;
}

async function logActivity(taskId: string, authorId: string | null, body: string, meta: Record<string, unknown> = {}) {
  await db.insert(taskActivity).values({ id: uuidv7(), taskId, kind: ACTIVITY_KIND.NOTE, authorId, body, meta });
  await publishChange(CHANGE_RESOURCE.TASK_ACTIVITY, CHANGE_ACTION.CREATE);
  await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
}

/** the slice of the task row the confirm flow touches */
type ConfirmTask = { id: string; ownerId: string | null; createdBy: string | null; assigneeId: string | null };

/** resolve a proposed assignee: inside the agent's chain -> as proposed, outside -> its supervisor */
async function resolveAssignee(item: SubtaskItem, task: ConfirmTask, events: string[]) {
  const proposed = await findByName(item.assigneeName);
  if (!proposed || !task.assigneeId) return { assigneeId: null, escalated: false };
  const chain = await supervisionChain(task.assigneeId);
  if (chain.has(proposed.id)) return { assigneeId: proposed.id, escalated: false };
  events.push(`"${item.assigneeName}" is outside ${'the agent'}'s chain → escalated to supervisor`);
  const supervisor = (await firstSupervisor(task.assigneeId)) ?? task.ownerId ?? task.createdBy;
  return { assigneeId: supervisor, escalated: true };
}

/** create one child task from a proposed subtask */
async function createSubtask(task: ConfirmTask, item: SubtaskItem, assigneeId: string | null, confirmedBy: string) {
  const childId = uuidv7();
  await db.insert(tasks).values({
    id: childId,
    title: item.title.slice(0, 200),
    description: item.description ?? '',
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
) {
  for (const item of payload.items ?? []) {
    const { assigneeId, escalated } = await resolveAssignee(item, task, events);
    const childId = await createSubtask(task, item, assigneeId, confirmedBy);
    if (assigneeId)
      await recordAssignment(childId, assigneeId, escalated ? 'subtask-escalated' : 'subtask', confirmedBy);
    events.push(`subtask "${item.title}" → ${escalated ? 'supervisor' : (item.assigneeName ?? 'unassigned')}`);
    await logActivity(task.id, confirmedBy, `subtask created: ${item.title}${escalated ? ' (escalated)' : ''}`, {
      childId,
    });
  }
  await refreshParentGating(task.id);
}

/** outside-chain reassign: re-target the agent's supervisor and close the proposal as escalated.
 * Returns true when the escalation arm executed — the caller must stop, the proposal is already closed. */
async function escalateReassignToSupervisor(
  task: ConfirmTask,
  target: { id: string },
  targetName: string | undefined,
  reason: string,
  confirmedBy: string,
  proposalId: string,
  note: string,
  events: string[],
) {
  if (!task.assigneeId) return false;
  const chain = await supervisionChain(task.assigneeId);
  if (chain.has(target.id)) return false;
  const sup = await firstSupervisor(task.assigneeId);
  if (!sup) return false;
  events.push(`target outside the agent's chain → escalated to supervisor`);
  await doReassign(task.id, sup, confirmedBy, reason, `escalated from ${targetName}`);
  await markExecuted(proposalId, confirmedBy, note, [...events, `reassigned to supervisor (escalation)`].join('; '));
  return true;
}

/**
 * confirm a proposal: execute it (subtasks created / reassign written through history).
 * Returns what happened per item, including escalation decisions.
 */
export async function confirmProposal(proposalId: string, confirmedBy: string, note = '') {
  const rows = await db.query.taskProposals.findMany({ where: { id: { eq: proposalId } } });
  const p = rows[0];
  if (!p) throw new Error('proposal not found');
  if (p.status !== PROPOSAL_STATUS.PROPOSED) throw new Error('proposal already decided');
  // task row is guaranteed by the proposal's FK (cascade delete removes proposals with tasks)
  const task = nonNull((await db.query.tasks.findMany({ where: { id: { eq: p.taskId } } }))[0]);

  const events: string[] = [];
  if (p.kind === PROPOSAL_KIND.SUBTASKS) {
    await executeSubtasks(task, p.payload as { items?: SubtaskItem[] }, confirmedBy, events);
  } else if (p.kind === PROPOSAL_KIND.REASSIGN) {
    const payload = p.payload as { targetName?: string; reason?: string };
    const target = await findByName(payload.targetName);
    if (!target) throw new Error(`employee "${payload.targetName}" not found`);
    if (
      await escalateReassignToSupervisor(
        task,
        target,
        payload.targetName,
        payload.reason ?? '',
        confirmedBy,
        proposalId,
        note,
        events,
      )
    )
      return { ok: true, events };
    // loop guard: refuse recent assignees
    const recent = await recentAssignees(task.id, 2);
    if (recent.includes(target.id)) throw new Error('loop guard: that person held this task recently');
    await doReassign(task.id, target.id, confirmedBy, payload.reason ?? '');
    events.push(`reassigned to ${payload.targetName}`);
  } else throw new Error(`unknown proposal kind ${p.kind}`);

  await markExecuted(proposalId, confirmedBy, note, events.join('; '));
  return { ok: true, events };
}

async function doReassign(taskId: string, employeeId: string, actorId: string, reason: string, extra = '') {
  await assignTask(taskId, employeeId, `reassign: ${reason}${extra ? ` (${extra})` : ''}`, actorId);
  const name = nonNull(
    await db.query.user.findFirst({ columns: { name: true }, where: { id: { eq: employeeId } } }),
  ).name;
  await logActivity(taskId, actorId, `reassigned to ${name}${extra ? ` (${extra})` : ''}`, { reassign: true, reason });
}

async function markExecuted(proposalId: string, decidedBy: string, note: string, summary: string) {
  await db
    .update(taskProposals)
    .set({ status: PROPOSAL_STATUS.EXECUTED, decidedBy, decidedAt: new Date(), decisionNote: note || summary })
    .where(eq(taskProposals.id, proposalId));
  await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
}

export async function rejectProposal(proposalId: string, decidedBy: string, note = '') {
  const rows = await db.query.taskProposals.findMany({ where: { id: { eq: proposalId } } });
  const p = rows[0];
  if (!p) throw new Error('proposal not found');
  if (p.status !== PROPOSAL_STATUS.PROPOSED) throw new Error('proposal already decided');
  await db
    .update(taskProposals)
    .set({ status: PROPOSAL_STATUS.REJECTED, decidedBy, decidedAt: new Date(), decisionNote: note })
    .where(eq(taskProposals.id, proposalId));
  await logActivity(p.taskId, decidedBy, `proposal rejected${note ? `: ${note}` : ''}`, { proposalId, kind: p.kind });
  return { ok: true };
}

/** store proposals parsed from a run envelope (called by the runner on settle).
 * AUTO-EXECUTION LAW (2026-10-16): a supervisor routing work to people inside its
 * own supervision chain needs NO approval — the proposal is executed immediately
 * by the same confirm path a human would use. Anything touching people outside
 * the chain (or unnamed routing targets) still waits for a human. */
export async function recordProposals(taskId: string, runId: string, payloads: Array<ProposalPayload>) {
  const agent =
    (await db.query.tasks.findFirst({ columns: { assigneeId: true }, where: { id: { eq: taskId } } }))?.assigneeId ??
    null;
  const chain = agent ? await supervisionChain(agent) : new Set<string>();
  for (const payload of payloads) {
    const proposalId = uuidv7();
    await db.insert(taskProposals).values({
      id: proposalId,
      taskId,
      runId,
      kind: payload.kind,
      payload: payload as unknown as Record<string, unknown>,
      status: PROPOSAL_STATUS.PROPOSED,
    });
    // every routing target named and inside the agent's own chain -> auto-execute
    let inChain = false;
    if (agent && chain.size > 1) {
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
        const r = await confirmProposal(proposalId, nonNull(agent), 'auto: routing within own supervision chain');
        // events may be empty for degenerate payloads — the fallback text covers it
        /* v8 ignore next */
        const summary = r.events.length ? r.events.join('; ') : 'auto-executed (within chain)';
        await logActivity(taskId, agent, `routing executed without approval — ${summary}`, {
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
