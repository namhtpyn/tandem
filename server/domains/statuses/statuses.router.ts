import { os } from '@orpc/server';
// statuses router — business logic lives in services/utils; this file only wires procedures
import { asc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import { CHANGE_RESOURCE, CHANGE_ACTION } from '#shared/enums';

import { db } from '../../db';
import {
  aiEmployees as aiEmployeesTable,
  projects as projectsTable,
  taskStatuses as taskStatusesTable,
  tasks as tasksTable,
  user as userTable,
} from '../../db/schema';
import { base, protectedProcedure, liveGenerator, publishChange, ORPCError } from '../kernel/kernel';

async function listStatuses() {
  const rows = await db.query.taskStatuses.findMany({ orderBy: { position: 'asc' } });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color,
    position: r.position,
    category: r.category,
    nextIds: r.nextIds,
  }));
}

export const statusesRouter = os.router({
  /** plain GET list (first-load data per the SSE law) */
  list: protectedProcedure.handler(() => listStatuses()),

  /** live task-status list (ordered) */
  live: protectedProcedure.handler(() => liveGenerator([CHANGE_RESOURCE.STATUSES], listStatuses)),

  /** create or update a status (upsert by id) */
  save: protectedProcedure
    .input(
      z.strictObject({
        id: z.string().min(1).max(64).optional(),
        name: z.string().min(1).max(64),
        color: z.enum(['neutral', 'primary', 'success', 'warning', 'error', 'info']).default('neutral'),
        position: z.number().int().min(0).max(99),
        category: z
          .enum(['backlog', 'ready', 'working', 'paused', 'waiting_answer', 'in_review', 'done', 'cancelled'])
          .default('backlog'),
        nextIds: z.array(z.string().min(1).max(64)).max(50).default([]),
      }),
    )
    .handler(async ({ input }) => {
      const id = input.id?.trim() || uuidv7();
      if (id === 'new') throw new ORPCError('BAD_REQUEST', { message: 'reserved status id' });
      // transitions must reference existing statuses (self ok)
      const all = await db.query.taskStatuses.findMany({ columns: { id: true } });
      const ids = new Set([...all.map((a) => a.id), id]);
      for (const n of input.nextIds) {
        if (!ids.has(n)) throw new ORPCError('BAD_REQUEST', { message: `unknown status in transitions: ${n}` });
      }
      const now = new Date();
      const values = {
        id,
        name: input.name,
        color: input.color,
        position: input.position,
        category: input.category,
        nextIds: input.nextIds,
        updatedAt: now,
      };
      await db
        .insert(taskStatusesTable)
        .values(values)
        .onConflictDoUpdate({
          target: taskStatusesTable.id,
          set: {
            name: values.name,
            color: values.color,
            position: values.position,
            category: values.category,
            nextIds: values.nextIds,
            updatedAt: now,
          },
        });
      await publishChange(CHANGE_RESOURCE.STATUSES, CHANGE_ACTION.UPDATE);
      return { id };
    }),

  /** delete a status: blocked while in use; deletes nothing else */
  remove: protectedProcedure.input(z.strictObject({ id: z.string().min(1) })).handler(async ({ input }) => {
    const inUse = await db.query.tasks.findMany({ columns: { id: true }, where: { status: { eq: input.id } } });
    if (inUse.length > 0) throw new ORPCError('BAD_REQUEST', { message: `status is used by ${inUse.length} task(s)` });
    const del = await db
      .delete(taskStatusesTable)
      .where(eq(taskStatusesTable.id, input.id))
      .returning({ id: taskStatusesTable.id });
    if (del.length === 0) throw new ORPCError('NOT_FOUND', { message: 'status not found' });
    await publishChange(CHANGE_RESOURCE.STATUSES, CHANGE_ACTION.UPDATE);
    return { ok: true };
  }),

  /** auto-assign a task via Jev (typed choice over employee candidates).
   *  No-op when a Jev key isn't configured or Jev is unsure — the task
   *  stays unassigned for a human decision. */
  assign: protectedProcedure.input(z.strictObject({ taskId: z.string().min(1) })).handler(async ({ input }) => {
    const tRows = await db.query.tasks.findMany({ where: { id: { eq: input.taskId } } });
    const task = tRows[0];
    if (!task) throw new ORPCError('NOT_FOUND', { message: 'task not found' });

    // candidates: every employee, with open-task load (non-terminal statuses)
    const users = await db.query.user.findMany();
    const aiRows = await db.query.aiEmployees.findMany();
    const aiByUser = new Map(aiRows.map((r) => [r.userId, r]));
    const statusRows = await db.query.taskStatuses.findMany();
    const terminal = new Set(
      statusRows.filter((s) => s.category === 'done' || s.category === 'cancelled').map((s) => s.id),
    );
    const allTasks = await db.query.tasks.findMany({ columns: { assigneeId: true, status: true } });
    const openByAssignee = new Map<string, number>();
    for (const t of allTasks) {
      if (t.assigneeId && !terminal.has(t.status)) {
        openByAssignee.set(t.assigneeId, (openByAssignee.get(t.assigneeId) ?? 0) + 1);
      }
    }
    let projName = null as string | null;
    if (task.projectId) {
      const projRows = await db
        .select({ name: projectsTable.name })
        .from(projectsTable)
        .where(eq(projectsTable.id, task.projectId));
      projName = projRows.length > 0 ? projRows[0]!.name : null;
    }

    const { pickAssignee } = await import('./decision.service');
    const { getSettings } = await import('../settings/settings.service');
    const decision = (await getSettings()).internalDecision;
    const result = await pickAssignee({
      taskTitle: task.title,
      taskDescription: task.description,
      projectName: projName,
      keySecretId: decision?.keySecretId ?? null,
      model: decision?.model ?? null,
      candidates: users.map((u) => ({
        id: u.id,
        name: u.name,
        kind: aiByUser.has(u.id) ? ('ai' as const) : ('human' as const),
        title: u.title ?? null,
        openTasks: openByAssignee.get(u.id) ?? 0,
      })),
    });

    if (!result.employeeId) {
      return {
        assigned: false as const,
        reason: result.fallbackReason,
        confidence: result.confidence,
        model: result.model,
        probabilities: result.probabilities,
      };
    }
    await db
      .update(tasksTable)
      .set({ assigneeId: result.employeeId, updatedAt: new Date() })
      .where(eq(tasksTable.id, task.id));
    await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
    return {
      assigned: true as const,
      employeeId: result.employeeId,
      confidence: result.confidence,
      model: result.model,
      probabilities: result.probabilities,
    };
  }),
});
