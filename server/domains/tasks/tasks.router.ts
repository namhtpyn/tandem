import { os } from '@orpc/server'
// tasks router — business logic lives in services/utils; this file only wires procedures
import { asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import {
  aiEmployees as aiEmployeesTable, projects as projectsTable, taskStatuses as taskStatusesTable, tasks as tasksTable, user as userTable,
} from '../../db/schema'
import { base, protectedProcedure, liveGenerator, publishChange, ORPCError } from '../kernel/kernel'
import type { TaskRow } from '../../../shared/types'

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
      status: r.status as 'todo' | 'doing' | 'done',
      projectId: r.projectId,
      projectName: (r.projectId && projNameById.get(r.projectId)) || null,
      assigneeId: r.assigneeId,
      assigneeName: (r.assigneeId && nameById.get(r.assigneeId)) || null,
      assigneeKind: r.assigneeId ? (aiIds.has(r.assigneeId) ? 'ai' : 'human') : null,
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
      const selfId = (context as { session?: { user?: { id?: string } } }).session?.user?.id ?? null
      const id = crypto.randomUUID()
      await db.insert(tasksTable).values({
        id,
        title: input.title,
        description: input.description ?? '',
        status,
        projectId: input.projectId ?? null,
        assigneeId: input.assigneeId ?? null,
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
      await db.update(tasksTable).set(patch).where(eq(tasksTable.id, input.id))
      await publishChange('tasks', 'update')
      return { ok: true }
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
