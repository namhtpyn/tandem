import { os } from '@orpc/server';
// tasks router — business logic lives in services/utils; this file only wires procedures
import { desc, EmptyFilter, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import { ACTIVITY_KIND, CHANGE_RESOURCE, CHANGE_ACTION, RUN_STATUS, type RunStatus, type ActivityKind } from '#shared/enums';
import { STATUS } from '#shared/status';
import type { TaskRow } from '#shared/types';
import { nonNull } from '#shared/utils/non-null';

import { db } from '../../db/index';
import { projects as projectsTable, tasks as tasksTable, taskProposals } from '../../db/schema';
import { env } from '../kernel/env';
import { protectedProcedure, employeeProcedure, liveGenerator, publishChange, ORPCError } from '../kernel/kernel';
import { recordAssignment, listAssignments } from './assignments.service';
import { refreshParentGating } from './gating.service';
import { approvalsInRoundBatch, openObligations, pendingForUser, pendingCounts } from './obligations.service';
import { confirmProposal, rejectProposal } from './proposals.service';
import { listReviews, logActivity } from './review.service';
import { dispatchTask, listRuns } from './runner.service';
import { listTaskThread } from './thread.service';
import {
  askQuestion,
  forwardQuestion,
  answerQuestion,
  submitResult,
  approveReview,
  requestChanges,
  rejectReview,
  abandonReview,
  listActivity,
} from './workflow.service';

type WorkflowSession = { getSession: () => Promise<{ user: { id: string } } | null> };

async function selfIdOf(context: unknown) {
  const session = await (context as unknown as WorkflowSession).getSession();
  return session?.user?.id ?? '';
}

/** run a workflow action, mapping service errors (all Error) to BAD_REQUEST */
async function runWorkflow(fn: () => Promise<unknown>) {
  try {
    return await fn();
  } catch (e) {
    // every service throw is an Error by construction
    throw new ORPCError('BAD_REQUEST', { message: (e as Error).message });
  }
}

/** group output attachments by their run id (inputs are not part of run payloads) */
export function groupOutputsByRun(
  atts: Array<{ id: string; runId: string | null; kind: string; filename: string; mime: string; size: number }>,
) {
  const outputsByRun = new Map<string, Array<{ id: string; filename: string; mime: string; size: number }>>();
  for (const a of atts) {
    if (a.kind !== 'output' || !a.runId) continue;
    const list = outputsByRun.get(a.runId) ?? [];
    list.push({ id: a.id, filename: a.filename, mime: a.mime, size: a.size });
    outputsByRun.set(a.runId, list);
  }
  return outputsByRun;
}

const listTasksSnapshot = async (): Promise<TaskRow[]> => {
  const rows = await db.query.tasks.findMany({
    columns: {
      id: true,
      title: true,
      description: true,
      status: true,
      projectId: true,
      assigneeId: true,
      ownerId: true,
      createdBy: true,
      reviewers: true,
      parentTaskId: true,
      dispatchAfter: true,
      failStreak: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  return mapTaskRows(rows);
};

/** exact list column set — the snapshot and the paged variant share it */
type TaskListRow = Pick<
  typeof tasksTable.$inferSelect,
  | 'id'
  | 'title'
  | 'description'
  | 'status'
  | 'projectId'
  | 'assigneeId'
  | 'ownerId'
  | 'createdBy'
  | 'reviewers'
  | 'parentTaskId'
  | 'dispatchAfter'
  | 'failStreak'
  | 'createdAt'
  | 'updatedAt'
>;

/** shared row → payload mapping for every tasks list shape (snapshot + paged) */
async function mapTaskRows(rows: TaskListRow[]): Promise<TaskRow[]> {
  const open = await openObligations(rows.map((r) => r.id));
  const holders = new Map<string, string>();
  for (const [tid, o] of open) if (o.holders[0]) holders.set(tid, o.holders[0]);
  const approvalsByTask = await approvalsInRoundBatch(rows.map((r) => r.id));
  const projRows = await db.query.projects.findMany({ columns: { id: true, name: true }, orderBy: { name: 'asc' } });
  const projNameById = new Map(projRows.map((p) => [p.id, p.name]));
  const users = await db.query.user.findMany({ columns: { id: true, name: true }, orderBy: { name: 'asc' } });
  const aiRows = await db.query.aiEmployees.findMany({ columns: { userId: true }, orderBy: { userId: 'asc' } });
  const aiIds = new Set(aiRows.map((r) => r.userId));
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status,
    projectId: r.projectId,
    projectName: (r.projectId && projNameById.get(r.projectId)) || null,
    assigneeId: r.assigneeId,
    assigneeName: (r.assigneeId && nameById.get(r.assigneeId)) || null,
    assigneeKind: r.assigneeId ? (aiIds.has(r.assigneeId) ? 'ai' : 'human') : null,
    ownerId: r.ownerId ?? r.createdBy,
    ownerName: nameById.get(r.ownerId ?? r.createdBy ?? '') ?? null,
    reviewers: r.reviewers,
    reviewerNames: r.reviewers.map((id) => nameById.get(id) ?? id),
    creatorName: nameById.get(r.createdBy ?? '') ?? null,
    reviewApprovals: approvalsByTask.get(r.id) ?? [],
    questionHolderId: holders.get(r.id) ?? null,
    questionHolderName: (holders.get(r.id) && nameById.get(nonNull(holders.get(r.id)))) || null,
    parentTaskId: r.parentTaskId,
    dispatchAfter: r.dispatchAfter ? r.dispatchAfter.toISOString() : null,
    failStreak: r.failStreak,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** paged/searched/filtered variant of the snapshot; total reflects the same filters */
async function listTasksPaged(
  input: { page: number; pageSize: number; q?: string; statusId?: string; inboxOfMe?: boolean },
  selfId: string,
) {
  const q = input.q?.trim();
  // escape LIKE wildcards so a q of '%' or '_' matches itself, not everything
  const escIlike = (s: string) => s.replace(/[\\%_]/g, '\\$&');
  const searchFilter = q
    ? { OR: [{ title: { ilike: `%${escIlike(q)}%` } }, { description: { ilike: `%${escIlike(q)}%` } }] }
    : undefined;
  const statusFilter = input.statusId ? { status: { eq: input.statusId } } : undefined;
  // inboxOfMe = tasks with a PENDING obligation on the caller — the same taskId
  // set `inbox` items come from (pendingForUser); empty set short-circuits
  let inboxFilter: { id: { inArray: string[] } } | undefined;
  if (input.inboxOfMe) {
    const pending = await pendingForUser(selfId);
    const ids = [...new Set(pending.map((p) => p.taskId))];
    if (ids.length === 0) return { data: [] as TaskRow[], total: 0 };
    inboxFilter = { id: { inArray: ids } };
  }
  const filters = [searchFilter, statusFilter, inboxFilter].filter((f) => f !== undefined);
  const where = filters.length === 0 ? EmptyFilter : filters.length === 1 ? nonNull(filters[0]) : { AND: filters };
  const { data, total } = await db.query.tasks.findManyAndCount({
    columns: {
      id: true,
      title: true,
      description: true,
      status: true,
      projectId: true,
      assigneeId: true,
      ownerId: true,
      createdBy: true,
      reviewers: true,
      parentTaskId: true,
      dispatchAfter: true,
      failStreak: true,
      createdAt: true,
      updatedAt: true,
    },
    where: where as never,
    orderBy: { createdAt: 'desc' },
    limit: input.pageSize,
    offset: (input.page - 1) * input.pageSize,
  });
  return { data: await mapTaskRows(data), total };
}

async function runsSnapshot(taskId: string) {
  const rows = await listRuns(taskId);
  const atts = await db.query.taskAttachments.findMany({
    columns: { id: true, runId: true, kind: true, filename: true, mime: true, size: true },
    where: { taskId: { eq: taskId } },
    orderBy: { createdAt: 'asc' },
  });
  const outputsByRun = groupOutputsByRun(atts);
  const users = await db.query.user.findMany({
    columns: { id: true, name: true, title: true },
    orderBy: { name: 'asc' },
  });
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  const titleById = new Map(users.map((u) => [u.id, u.title]));
  return rows.map((r) => ({
    id: r.id,
    taskId: r.taskId,
    employeeId: r.employeeId,
    // `?? null` unreachable by FK (employee_id references user.id) — defensive only
    /* v8 ignore next */
    agentTitle: r.employeeId ? (titleById.get(r.employeeId) ?? null) : null,
    // `?? null` is unreachable by FK (employee_id references user.id) — defensive only
    /* v8 ignore next */
    agentName: r.employeeId ? (nameById.get(r.employeeId) ?? null) : null,
    environmentId: r.environmentId,
    status: r.status as RunStatus,
    exitCode: r.exitCode,
    output: r.output,
    prompt: r.prompt,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    outputs: outputsByRun.get(r.id) ?? [],
  }));
}

async function activitySnapshot(taskId: string) {
  const rows = await listActivity(taskId);
  const users = await db.query.user.findMany({ columns: { id: true, name: true }, orderBy: { name: 'asc' } });
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    id: r.id,
    taskId: r.taskId,
    kind: r.kind as ActivityKind,
    authorId: r.authorId,
    authorName: (r.authorId && nameById.get(r.authorId)) || null,
    body: r.body,
    meta: r.meta as Record<string, unknown>,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** the referenced assignee/project must exist before a task write points at them */
async function requireExistingRefs(input: { assigneeId?: string | null; projectId?: string | null }) {
  if (input.assigneeId) {
    const u = await db.query.user.findFirst({ columns: { id: true }, where: { id: { eq: input.assigneeId } } });
    if (!u) throw new ORPCError('BAD_REQUEST', { message: 'assignee does not exist' });
  }
  if (input.projectId) {
    const p = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(eq(projectsTable.id, input.projectId));
    if (p.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'project does not exist' });
  }
}

/** first status by position unless the caller names one; a named one must exist
 *  AND be ready-category — dispatch eligibility starts at creation */
async function resolveCreatedStatus(requested?: string) {
  const statusRows = await db.query.taskStatuses.findMany({
    columns: { id: true, category: true },
    orderBy: { position: 'asc' },
  });
  if (statusRows.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'no task statuses defined' });
  if (!requested) return nonNull(statusRows[0]).id;
  const found = statusRows.find((r) => r.id === requested);
  if (!found) throw new ORPCError('BAD_REQUEST', { message: 'status does not exist' });
  if (found.category !== 'ready') {
    throw new ORPCError('BAD_REQUEST', { message: 'created tasks must start in a ready-category status' });
  }
  return found.id;
}

/** the workflow owns status moves — reject raw status writes with a targeted error */
const updateInput = z.preprocess(
  (raw) => {
    if (raw !== null && typeof raw === 'object' && 'status' in raw) {
      throw new ORPCError('BAD_REQUEST', { message: 'status changes go through the workflow endpoints' });
    }
    return raw;
  },
  z.strictObject({
    id: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(10_000).nullable().optional(),
    projectId: z.string().min(1).nullable().optional(),
    assigneeId: z.string().min(1).nullable().optional(),
    ownerId: z.string().min(1).nullable().optional(),
    reviewers: z.array(z.string().min(1)).max(10).nullable().optional(),
  }),
);

/** the dispatcher's eligibility rule restated for the manual path: ready-category
 *  status, AI assignee, and no run already in flight */
async function requireDispatchable(taskId: string) {
  const rows = await db.query.tasks.findMany({
    columns: { id: true, status: true, assigneeId: true },
    where: { id: { eq: taskId } },
    orderBy: { createdAt: 'asc' },
  });
  const task = nonNull(rows[0]);
  const statusRows = await db.query.taskStatuses.findMany({
    columns: { id: true },
    where: { category: { eq: 'ready' } },
    orderBy: { position: 'asc' },
  });
  const readyIds = new Set(statusRows.map((s) => s.id));
  const aiRows = await db.query.aiEmployees.findMany({ columns: { userId: true }, orderBy: { userId: 'asc' } });
  const aiIds = new Set(aiRows.map((r) => r.userId));
  if (!readyIds.has(task.status) || !task.assigneeId || !aiIds.has(task.assigneeId)) {
    throw new ORPCError('BAD_REQUEST', {
      message: 'task is not dispatchable (needs a ready-category status and an AI assignee)',
    });
  }
  const running = await db.query.taskRuns.findMany({
    columns: { id: true },
    where: { taskId: { eq: taskId }, status: { eq: RUN_STATUS.RUNNING } },
    orderBy: { id: 'asc' },
  });
  if (running.length > 0) throw new ORPCError('BAD_REQUEST', { message: 'task already has a running run' });
}

/** only fields the caller actually sent land in the patch; explicit nulls clear nothing */
function buildUpdatePatch(input: {
  title?: string;
  description?: string | null;
  projectId?: string | null;
  assigneeId?: string | null;
  ownerId?: string | null;
  reviewers?: string[] | null;
}) {
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.projectId !== undefined) patch.projectId = input.projectId;
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined && input.description !== null) patch.description = input.description;
  if (input.assigneeId !== undefined) patch.assigneeId = input.assigneeId;
  if (input.ownerId !== undefined) patch.ownerId = input.ownerId;
  if (input.reviewers !== undefined && input.reviewers !== null) patch.reviewers = input.reviewers;
  return patch;
}

/** note a newly created subtask on the parent task's activity thread */
async function logSubtaskCreation(parentTaskId: string, authorId: string | null, childId: string, childTitle: string) {
  await logActivity(parentTaskId, ACTIVITY_KIND.STATUS, authorId, `subtask created: ${childTitle}`, { childId });
}

export const tasksRouter = os.router({
  /** live list — tasks with assignee info, newest first */
  /** plain GET list (first-load data per the SSE law) */
  list: protectedProcedure.handler(() => listTasksSnapshot()),

  /** paged + searched + filtered rows for the tasks manager table (same row shape as list) */
  listPaged: protectedProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(20),
        q: z.string().trim().optional(),
        statusId: z.string().min(1).optional(),
        inboxOfMe: z.boolean().optional(),
      }),
    )
    .handler(async ({ input, context }) =>
      // the caller identity is only resolved when the inbox filter asks for it
      listTasksPaged(input, input.inboxOfMe ? await selfIdOf(context) : ''),
    ),

  live: protectedProcedure.handler(() => liveGenerator([CHANGE_RESOURCE.TASKS], listTasksSnapshot)),

  /** create a task */
  create: protectedProcedure
    .input(
      z.strictObject({
        title: z.string().min(1).max(200),
        description: z.string().max(10_000).optional(),
        projectId: z.string().min(1).nullable().optional(),
        assigneeId: z.string().min(1).nullable().optional(),
        ownerId: z.string().min(1).nullable().optional(),
        reviewers: z.array(z.string().min(1)).max(10).optional(),
        status: z.string().min(1).max(64).optional(),
        parentId: z.string().min(1).nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      await requireExistingRefs(input);
      const status = await resolveCreatedStatus(input.status);
      const session = await (
        context as unknown as { getSession: () => Promise<{ user: { id: string } } | null> }
      ).getSession();
      const selfId = session?.user?.id ?? null;
      if (input.parentId) {
        const parent = await db.query.tasks.findFirst({ columns: { id: true }, where: { id: { eq: input.parentId } } });
        if (!parent) throw new ORPCError('BAD_REQUEST', { message: 'parent task does not exist' });
      }
      const id = uuidv7();
      await db.insert(tasksTable).values({
        id,
        title: input.title,
        description: input.description ?? '',
        status,
        projectId: input.projectId ?? null,
        assigneeId: input.assigneeId ?? null,
        ownerId: input.ownerId ?? selfId,
        reviewers: input.reviewers ?? [],
        parentTaskId: input.parentId ?? null,
        createdBy: selfId,
      });
      if (input.assigneeId) await recordAssignment(id, input.assigneeId, 'created', selfId);
      if (input.parentId) {
        await logSubtaskCreation(input.parentId, selfId, id, input.title);
        await refreshParentGating(id);
      }
      await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.CREATE);
      await publishChange(CHANGE_RESOURCE.TASK_ACTIVITY, CHANGE_ACTION.CREATE);
      return { id };
    }),

  /** update a task (title/description/assignee) — status moves live in the workflow */
  update: protectedProcedure.input(updateInput).handler(async ({ input, context }) => {
    const rows = await db.query.tasks.findMany({
      columns: { status: true, assigneeId: true },
      where: { id: { eq: input.id } },
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length === 0) throw new ORPCError('NOT_FOUND', { message: 'task not found' });
    await requireExistingRefs(input);
    const actorId = await selfIdOf(context);
    await db.update(tasksTable).set(buildUpdatePatch(input)).where(eq(tasksTable.id, input.id));
    if (input.assigneeId !== undefined && input.assigneeId !== nonNull(rows[0]).assigneeId) {
      await recordAssignment(input.id, input.assigneeId, 'manual', actorId);
    }
    await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
    await publishChange(CHANGE_RESOURCE.TASK_ACTIVITY, CHANGE_ACTION.CREATE);
    return { ok: true };
  }),

  /** manual status move: graph-legal + category-allowed; done/in-review stay workflow-only */
  setStatus: employeeProcedure
    .input(z.strictObject({ id: z.string().min(1), status: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const rows = await db.query.tasks.findMany({
        columns: { status: true, parentTaskId: true },
        where: { id: { eq: input.id } },
        orderBy: { createdAt: 'asc' },
      });
      if (rows.length === 0) throw new ORPCError('NOT_FOUND', { message: 'task not found' });
      const cur = nonNull(rows[0]).status;
      const [curRow] = await db.query.taskStatuses.findMany({
        columns: { nextIds: true },
        where: { id: { eq: cur } },
        orderBy: { position: 'asc' },
      });
      if (!curRow || !curRow.nextIds.includes(input.status)) {
        throw new ORPCError('BAD_REQUEST', { message: `cannot move from '${cur}' to '${input.status}'` });
      }
      const terminal = new Set<string>([STATUS.done, STATUS.cancelled, STATUS.inReview, STATUS.waitingAnswer]);
      if (terminal.has(input.status)) {
        throw new ORPCError('BAD_REQUEST', { message: 'use the workflow actions for review, completion and cancellation' });
      }
      const actorId = await selfIdOf(context);
      await db
        .update(tasksTable)
        .set({ status: input.status, updatedAt: new Date() })
        .where(eq(tasksTable.id, input.id));
      await logActivity(input.id, ACTIVITY_KIND.STATUS, actorId, `status: ${cur} → ${input.status}`, {});
      const parentId = rows.at(0)?.parentTaskId;
      if (parentId) await refreshParentGating(parentId);
      await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
      return { ok: true };
    }),

  /** assignee asks the owner a question (task → waiting-answer) */
  /** the waiting-on-you inbox: tasks with a pending obligation on me, plus counts */
  inbox: protectedProcedure.handler(async ({ context }) => {
    const me = await selfIdOf(context);
    const items = await pendingForUser(me);
    const counts = await pendingCounts(me);
    return { items, counts };
  }),

  /** subtask children of a task (for the detail page subtasks section) */
  subtasks: protectedProcedure.input(z.object({ taskId: z.string().min(1) })).handler(async ({ input }) => {
    const rows = await db
      .select({
        id: tasksTable.id,
        title: tasksTable.title,
        status: tasksTable.status,
        assigneeId: tasksTable.assigneeId,
      })
      .from(tasksTable)
      .where(eq(tasksTable.parentTaskId, input.taskId))
      .orderBy(tasksTable.createdAt);
    return { items: rows };
  }),

  /** assignment history for a task (append-only ledger) */
  assignments: protectedProcedure.input(z.object({ taskId: z.string().min(1) })).handler(async ({ input }) => {
    const rows = await listAssignments(input.taskId);
    const users = await db.query.user.findMany({ columns: { id: true, name: true }, orderBy: { name: 'asc' } });
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    return {
      items: rows.map((x) => ({
        id: x.id,
        employeeId: x.employeeId,
        employeeName: x.employeeId ? nonNull(nameById.get(x.employeeId)) : null,
        reason: x.reason,
        actorId: x.actorId,
        startedAt: x.startedAt.toISOString(),
        endedAt: x.endedAt ? x.endedAt.toISOString() : null,
      })),
    };
  }),

  /** proposals on a task (agent [SUBTASKS]/[REASSIGN] awaiting decision) */
  proposals: protectedProcedure.input(z.object({ taskId: z.string().min(1) })).handler(async ({ input }) => {
    const rows = await db
      .select()
      .from(taskProposals)
      .where(eq(taskProposals.taskId, input.taskId))
      .orderBy(desc(taskProposals.createdAt));
    return {
      items: rows.map((p) => ({
        id: p.id,
        kind: p.kind,
        payload: p.payload,
        status: p.status.toLowerCase(),
        decisionNote: p.decisionNote,
        createdAt: p.createdAt.toISOString(),
      })),
    };
  }),

  /** confirm an agent proposal (single writer executes: creates subtasks / reassigns) */
  confirmProposal: employeeProcedure
    .input(z.object({ proposalId: z.string().min(1), note: z.string().max(2000).optional() }))
    .handler(async ({ input, context }) => {
      const me = await selfIdOf(context);
      return confirmProposal(input.proposalId, me, input.note ?? '');
    }),

  /** reject an agent proposal (note rides the next brief to prevent re-propose loops) */
  rejectProposal: employeeProcedure
    .input(z.object({ proposalId: z.string().min(1), note: z.string().max(2000).optional() }))
    .handler(async ({ input, context }) => {
      const me = await selfIdOf(context);
      return rejectProposal(input.proposalId, me, input.note ?? '');
    }),

  ask: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1), body: z.string().min(1).max(4_000) }))
    .handler(async ({ input, context }) => {
      const selfId = await selfIdOf(context);
      if (!selfId) throw new ORPCError('UNAUTHORIZED', { message: 'no session' });
      return await runWorkflow(() => askQuestion(input.taskId, selfId, input.body));
    }),

  /** current holder forwards the question down the chain */
  forward: protectedProcedure
    .input(
      z.strictObject({
        taskId: z.string().min(1),
        toEmployeeId: z.string().min(1),
        body: z.string().max(4_000).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const selfId = await selfIdOf(context);
      if (!selfId) throw new ORPCError('UNAUTHORIZED', { message: 'no session' });
      return await runWorkflow(() => forwardQuestion(input.taskId, selfId, input.toEmployeeId, input.body ?? ''));
    }),

  /** anyone in the chain answers → assignee resumes */
  answer: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1), body: z.string().min(1).max(10_000) }))
    .handler(async ({ input, context }) => {
      const selfId = await selfIdOf(context);
      if (!selfId) throw new ORPCError('UNAUTHORIZED', { message: 'no session' });
      return await runWorkflow(() => answerQuestion(input.taskId, selfId, input.body));
    }),

  /** assignee submits the result for review (or done when no reviewers) */
  submit: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1), body: z.string().max(10_000).optional() }))
    .handler(async ({ input, context }) => {
      const selfId = await selfIdOf(context);
      if (!selfId) throw new ORPCError('UNAUTHORIZED', { message: 'no session' });
      return await runWorkflow(() => submitResult(input.taskId, selfId, input.body ?? ''));
    }),

  /** reviewer approves (unanimous → done) */
  approve: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1), body: z.string().max(4_000).optional() }))
    .handler(async ({ input, context }) => {
      const selfId = await selfIdOf(context);
      if (!selfId) throw new ORPCError('UNAUTHORIZED', { message: 'no session' });
      return await runWorkflow(() => approveReview(input.taskId, selfId, input.body ?? ''));
    }),

  /** reviewer requests changes → assignee back to work */
  requestChanges: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1), body: z.string().min(1).max(10_000) }))
    .handler(async ({ input, context }) => {
      const selfId = await selfIdOf(context);
      if (!selfId) throw new ORPCError('UNAUTHORIZED', { message: 'no session' });
      return await runWorkflow(() => requestChanges(input.taskId, selfId, input.body));
    }),

  /** REVIEW LAW: reviewer rejects — HUMAN-only terminal verdict, task cancelled */
  reject: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1), body: z.string().max(4_000).optional() }))
    .handler(async ({ input, context }) => {
      const selfId = await selfIdOf(context);
      /* v8 ignore next -- protectedProcedure already rejects sessionless callers */
      if (!selfId) throw new ORPCError('UNAUTHORIZED', { message: 'no session' });
      return await runWorkflow(() => rejectReview(input.taskId, selfId, input.body ?? ''));
    }),

  /** REVIEW LAW: per-reviewer verdict checklist for the task page */
  reviews: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1) }))
    .handler(({ input }) => listReviews(input.taskId)),

  /** reviewer or owner abandons the task outright */
  abandon: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1), body: z.string().max(4_000).optional() }))
    .handler(async ({ input, context }) => {
      const selfId = await selfIdOf(context);
      if (!selfId) throw new ORPCError('UNAUTHORIZED', { message: 'no session' });
      return await runWorkflow(() => abandonReview(input.taskId, selfId, input.body ?? ''));
    }),

  /** activity feed for one task (live) */
  activityList: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1) }))
    .handler(({ input }) => activitySnapshot(input.taskId)),

  activity: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1) }))
    .handler(({ input }) =>
      liveGenerator([CHANGE_RESOURCE.TASK_ACTIVITY, CHANGE_RESOURCE.TASKS], () => activitySnapshot(input.taskId)),
    ),

  /** runs for a task (live) — streaming output tail from agent dispatches */
  runsList: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1) }))
    .handler(({ input }) => runsSnapshot(input.taskId)),

  /** the unified conversation thread (snapshot) — base messages with their run/activity extension */
  threadList: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1) }))
    .handler(({ input }) => listTaskThread(input.taskId)),

  thread: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1) }))
    .handler(({ input }) =>
      liveGenerator([CHANGE_RESOURCE.TASK_ACTIVITY, CHANGE_RESOURCE.RUNS, CHANGE_RESOURCE.TASKS], () =>
        listTaskThread(input.taskId),
      ),
    ),

  runs: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1) }))
    .handler(({ input }) =>
      liveGenerator([CHANGE_RESOURCE.RUNS, CHANGE_RESOURCE.TASKS], () => runsSnapshot(input.taskId)),
    ),

  /** manually dispatch a task to its AI assignee (the dispatcher also fires automatically) */
  dispatch: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const session = await (
        context as unknown as { getSession: () => Promise<{ user: { id: string } } | null> }
      ).getSession();
      const selfId = session?.user?.id ?? null;
      if (!selfId) throw new ORPCError('UNAUTHORIZED', { message: 'no session' });
      // the manual path must not bypass the queue worker's eligibility rule
      await requireDispatchable(input.taskId);
      return await runWorkflow(async () => {
        const tandemUrl = env.TANDEM_PUBLIC_URL ?? 'http://localhost:3000';
        const handle = await dispatchTask(input.taskId, tandemUrl);
        return { runId: handle.runId };
      });
    }),

  /** delete a task — blocked while a run is in flight; parents re-gate after */
  remove: protectedProcedure.input(z.strictObject({ id: z.string().min(1) })).handler(async ({ input }) => {
    const rows = await db.query.tasks.findMany({
      columns: { id: true, parentTaskId: true },
      where: { id: { eq: input.id } },
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length === 0) throw new ORPCError('NOT_FOUND', { message: 'task not found' });
    const running = await db.query.taskRuns.findMany({
      columns: { id: true },
      where: { taskId: { eq: input.id }, status: { eq: RUN_STATUS.RUNNING } },
      orderBy: { id: 'asc' },
    });
    if (running.length > 0) throw new ORPCError('BAD_REQUEST', { message: 'cancel the running run first' });
    await db.delete(tasksTable).where(eq(tasksTable.id, input.id));
    // deleting a subtask can release the parent's auto-block
    const parentId = nonNull(rows[0]).parentTaskId;
    if (parentId) await refreshParentGating(parentId);
    await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.DELETE);
    return { ok: true };
  }),
});
