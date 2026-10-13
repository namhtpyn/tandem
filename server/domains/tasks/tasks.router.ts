import { os } from '@orpc/server'
// tasks router — business logic lives in services/utils; this file only wires procedures
import { asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import {
  aiEmployees as aiEmployeesTable, projects as projectsTable, taskStatuses as taskStatusesTable, tasks as tasksTable, user as userTable,
} from '../../db/schema'
import { base, protectedProcedure, liveGenerator, publishChange, ORPCError } from '../kernel/kernel'
import { askQuestion, forwardQuestion, answerQuestion, submitResult, approveReview, requestChanges, abandonReview, listActivity } from './workflow.service'
import { dispatchTask, listRuns } from './runner.service'
import type { TaskRow } from '../../../shared/types'

type WorkflowSession = { getSession: () => Promise<{ user: { id: string } } | null> }

async function selfIdOf(context: unknown): Promise<string> {
  const session = await (context as unknown as WorkflowSession).getSession()
  return session?.user?.id ?? ''
}

/** run a workflow action, mapping service errors (all Error) to BAD_REQUEST */
async function runWorkflow(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn()
  } catch (e) {
    // every service throw is an Error by construction
    throw new ORPCError('BAD_REQUEST', { message: (e as Error).message })
  }
}

export const tasksRouter = os.router({
  /** live list — tasks with assignee info, newest first */
  live: protectedProcedure.handler(() => liveGenerator(['tasks'], async (): Promise<TaskRow[]> => {
    const rows = await db.select().from(tasksTable).orderBy(desc(tasksTable.createdAt))
    const projRows = await db.select({ id: projectsTable.id, name: projectsTable.name }).from(projectsTable)
    const projNameById = new Map(projRows.map(p => [p.id, p.name]))
    const users = await db.select({ id: userTable.id, name: userTable.name }).from(userTable)
    const aiRows = await db.select({ userId: aiEmployeesTable.userId }).from(aiEmployeesTable)
    const aiIds = new Set(aiRows.map(r => r.userId))
    const nameById = new Map(users.map(u => [u.id, u.name]))
    return rows.map(r => ({
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
      reviewerNames: r.reviewers.map(id => nameById.get(id) ?? id),
      reviewApprovals: r.reviewApprovals,
      questionHolderId: r.questionHolderId,
      questionHolderName: (r.questionHolderId && nameById.get(r.questionHolderId)) || null,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }))
  })),

  /** create a task */
  create: protectedProcedure
    .input(z.strictObject({
      title: z.string().min(1).max(200),
      description: z.string().max(10_000).optional(),
      projectId: z.string().min(1).nullable().optional(),
      assigneeId: z.string().min(1).nullable().optional(),
      ownerId: z.string().min(1).nullable().optional(),
      reviewers: z.array(z.string().min(1)).max(10).optional(),
      status: z.string().min(1).max(64).optional(),
    }))
    .handler(async ({ input, context }) => {
      if (input.assigneeId) {
        const u = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.id, input.assigneeId))
        if (u.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'assignee does not exist' })
      }
      if (input.projectId) {
        const p = await db.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, input.projectId))
        if (p.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'project does not exist' })
      }
      const statusRows = await db.select().from(taskStatusesTable).orderBy(asc(taskStatusesTable.position))
      if (statusRows.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'no task statuses defined' })
      let status = statusRows[0]!.id
      if (input.status) {
        const found = statusRows.find(r => r.id === input.status)
        if (!found) throw new ORPCError('BAD_REQUEST', { message: 'status does not exist' })
        status = found.id
      }
      const session = await (context as unknown as { getSession: () => Promise<{ user: { id: string } } | null> }).getSession()
      const selfId = session?.user?.id ?? null
      const id = crypto.randomUUID()
      await db.insert(tasksTable).values({
        id,
        title: input.title,
        description: input.description ?? '',
        status,
        projectId: input.projectId ?? null,
        assigneeId: input.assigneeId ?? null,
        ownerId: input.ownerId ?? selfId,
        reviewers: input.reviewers ?? [],
        createdBy: selfId,
      })
      await publishChange('tasks', 'create')
      return { id }
    }),

  /** update a task (title/description/status/assignee) */
  update: protectedProcedure
    .input(z.strictObject({
      id: z.string().min(1),
      title: z.string().min(1).max(200).optional(),
      description: z.string().max(10_000).nullable().optional(),
      status: z.string().min(1).max(64).optional(),
      projectId: z.string().min(1).nullable().optional(),
      assigneeId: z.string().min(1).nullable().optional(),
      ownerId: z.string().min(1).nullable().optional(),
      reviewers: z.array(z.string().min(1)).max(10).nullable().optional(),
    }))
    .handler(async ({ input }) => {
      const rows = await db.select().from(tasksTable).where(eq(tasksTable.id, input.id))
      if (rows.length === 0) throw new ORPCError('NOT_FOUND', { message: 'task not found' })
      if (input.assigneeId) {
        const u = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.id, input.assigneeId))
        if (u.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'assignee does not exist' })
      }
      if (input.projectId) {
        const p = await db.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, input.projectId))
        if (p.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'project does not exist' })
      }
      if (input.status !== undefined) {
        const stRows = await db.select().from(taskStatusesTable).where(eq(taskStatusesTable.id, input.status))
        const target = stRows[0]
        if (!target) throw new ORPCError('BAD_REQUEST', { message: 'status does not exist' })
        // enforce the workflow: target must be reachable from the current status
        if (rows[0]!.status !== input.status) {
          const cur = (await db.select().from(taskStatusesTable).where(eq(taskStatusesTable.id, rows[0]!.status)))[0]
          if (cur && !cur.nextIds.includes(input.status)) {
            throw new ORPCError('BAD_REQUEST', { message: `cannot move from '${cur.name}' to '${target.name}'` })
          }
        }
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() }
      if (input.projectId !== undefined) patch.projectId = input.projectId
      if (input.title !== undefined) patch.title = input.title
      if (input.description !== undefined && input.description !== null) patch.description = input.description
      if (input.status !== undefined) patch.status = input.status
      if (input.assigneeId !== undefined) patch.assigneeId = input.assigneeId
      if (input.ownerId !== undefined) patch.ownerId = input.ownerId
      if (input.reviewers !== undefined && input.reviewers !== null) patch.reviewers = input.reviewers
      await db.update(tasksTable).set(patch).where(eq(tasksTable.id, input.id))
      await publishChange('tasks', 'update')
      return { ok: true }
    }),

  /** assignee asks the owner a question (task → waiting-answer) */
  ask: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1), body: z.string().min(1).max(4_000) }))
    .handler(async ({ input, context }) => {
      const selfId = await selfIdOf(context)
      if (!selfId) throw new ORPCError('UNAUTHORIZED', { message: 'no session' })
      return await runWorkflow(() => askQuestion(input.taskId, selfId, input.body))
    }),

  /** current holder forwards the question down the chain */
  forward: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1), toEmployeeId: z.string().min(1), body: z.string().max(4_000).optional() }))
    .handler(async ({ input, context }) => {
      const selfId = await selfIdOf(context)
      if (!selfId) throw new ORPCError('UNAUTHORIZED', { message: 'no session' })
      return await runWorkflow(() => forwardQuestion(input.taskId, selfId, input.toEmployeeId, input.body ?? ''))
    }),

  /** anyone in the chain answers → assignee resumes */
  answer: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1), body: z.string().min(1).max(10_000) }))
    .handler(async ({ input, context }) => {
      const selfId = await selfIdOf(context)
      if (!selfId) throw new ORPCError('UNAUTHORIZED', { message: 'no session' })
      return await runWorkflow(() => answerQuestion(input.taskId, selfId, input.body))
    }),

  /** assignee submits the result for review (or done when no reviewers) */
  submit: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1), body: z.string().max(10_000).optional() }))
    .handler(async ({ input, context }) => {
      const selfId = await selfIdOf(context)
      if (!selfId) throw new ORPCError('UNAUTHORIZED', { message: 'no session' })
      return await runWorkflow(() => submitResult(input.taskId, selfId, input.body ?? ''))
    }),

  /** reviewer approves (unanimous → done) */
  approve: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1), body: z.string().max(4_000).optional() }))
    .handler(async ({ input, context }) => {
      const selfId = await selfIdOf(context)
      if (!selfId) throw new ORPCError('UNAUTHORIZED', { message: 'no session' })
      return await runWorkflow(() => approveReview(input.taskId, selfId, input.body ?? ''))
    }),

  /** reviewer requests changes → assignee back to work */
  requestChanges: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1), body: z.string().min(1).max(10_000) }))
    .handler(async ({ input, context }) => {
      const selfId = await selfIdOf(context)
      if (!selfId) throw new ORPCError('UNAUTHORIZED', { message: 'no session' })
      return await runWorkflow(() => requestChanges(input.taskId, selfId, input.body))
    }),

  /** reviewer or owner abandons the task outright */
  abandon: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1), body: z.string().max(4_000).optional() }))
    .handler(async ({ input, context }) => {
      const selfId = await selfIdOf(context)
      if (!selfId) throw new ORPCError('UNAUTHORIZED', { message: 'no session' })
      return await runWorkflow(() => abandonReview(input.taskId, selfId, input.body ?? ''))
    }),

  /** activity feed for one task (live) */
  activity: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1) }))
    .handler(({ input }) => liveGenerator(['taskActivity', 'tasks'], async () => {
      const rows = await listActivity(input.taskId)
      const users = await db.select({ id: userTable.id, name: userTable.name }).from(userTable)
      const nameById = new Map(users.map(u => [u.id, u.name]))
      return rows.map(r => ({
        id: r.id,
        taskId: r.taskId,
        kind: r.kind as 'question' | 'answer' | 'forward' | 'note' | 'verdict' | 'status',
        authorId: r.authorId,
        authorName: (r.authorId && nameById.get(r.authorId)) || null,
        body: r.body,
        meta: r.meta as Record<string, unknown>,
        createdAt: r.createdAt.toISOString(),
      }))
    })),

  /** runs for a task (live) — streaming output tail from agent dispatches */
  runs: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1) }))
    .handler(({ input }) => liveGenerator(['runs', 'tasks'], async () => {
      const rows = await listRuns(input.taskId)
      return rows.map(r => ({
        id: r.id,
        taskId: r.taskId,
        employeeId: r.employeeId,
        environmentId: r.environmentId,
        status: r.status as 'running' | 'done' | 'failed',
        exitCode: r.exitCode,
        output: r.output,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      }))
    })),

  /** manually dispatch a task to its AI assignee (the dispatcher also fires automatically) */
  dispatch: protectedProcedure
    .input(z.strictObject({ taskId: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const session = await (context as unknown as { getSession: () => Promise<{ user: { id: string } } | null> }).getSession()
      const selfId = session?.user?.id ?? null
      if (!selfId) throw new ORPCError('UNAUTHORIZED', { message: 'no session' })
      return await runWorkflow(async () => {
        const tandemUrl = process.env.TANDEM_PUBLIC_URL || 'http://localhost:3000'
        const handle = await dispatchTask(input.taskId, tandemUrl)
        return { runId: handle.runId }
      })
    }),

  /** delete a task */
  remove: protectedProcedure
    .input(z.strictObject({ id: z.string().min(1) }))
    .handler(async ({ input }) => {
      const rows = await db.select({ id: tasksTable.id }).from(tasksTable).where(eq(tasksTable.id, input.id))
      if (rows.length === 0) throw new ORPCError('NOT_FOUND', { message: 'task not found' })
      await db.delete(tasksTable).where(eq(tasksTable.id, input.id))
      await publishChange('tasks', 'delete')
      return { ok: true }
    }),
})
