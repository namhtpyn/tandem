import { os } from '@orpc/server';
// statuses router — business logic lives in services/utils; this file only wires procedures
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import { CHANGE_RESOURCE, CHANGE_ACTION, CATEGORY } from '#shared/enums';
import { STATUS } from '#shared/status';
import { nonNull } from '#shared/utils/non-null';
import { storable, storableId, storableIdRef } from '#shared/utils/storable-text';

import { db } from '../../db/index';
import { projects as projectsTable, taskStatuses as taskStatusesTable, tasks as tasksTable } from '../../db/schema';
import {
  ORPCError,
  adminProcedure,
  employeeProcedure,
  liveGenerator,
  protectedProcedure,
  publishChange,
} from '../kernel/kernel';

/** STATUS-ORIGIN MEMORY LAW (#432, SPEC "STATUS FREEDOM / CATEGORY-GATE LAW"): a
 *  machine origin (tasks.pre_block_status / tasks.park_from_status) is a raw id with no
 *  FK whose CATEGORY every reader resolves — the settle flip's machine-home term, the
 *  unblock restore target, the review-turn mint gate, both recovery sweeps and the
 *  probe. A status mutation must therefore never leave a recorded home naming no row:
 *  a removal RE-HOMES every recorded reference onto the canonical built-in status of
 *  the SAME category inside the delete's own transaction. TWO categories have no
 *  faithful home and refuse instead of guessing: 'backlog' has no built-in row, and
 *  'paused''s only built-in IS the block state itself — a home re-homed onto BLOCKED
 *  would restore the task into the block, clear both origins and strand it with no arm
 *  left to fire (the #88 to-do demotion is the restore path's job, never the delete's).
 *  The target's LIVE category is re-verified at delete time: an admin can recategorize
 *  a built-in, and a frozen map would then re-home into the wrong category. */
const CANONICAL_BY_CATEGORY: Record<string, string> = {
  [CATEGORY.READY]: STATUS.todo,
  [CATEGORY.WORKING]: STATUS.doing,
  [CATEGORY.WAITING_ANSWER]: STATUS.waitingAnswer,
  [CATEGORY.IN_REVIEW]: STATUS.inReview,
  [CATEGORY.DONE]: STATUS.done,
  [CATEGORY.CANCELLED]: STATUS.cancelled,
};

async function listStatuses() {
  const rows = await db.query.taskStatuses.findMany({
    columns: { id: true, name: true, color: true, position: true, category: true, nextIds: true },
    orderBy: { position: 'asc' },
  });
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
  live: protectedProcedure.handler(({ context }) => liveGenerator([CHANGE_RESOURCE.STATUSES], listStatuses, context)),

  /** create or update a status (upsert by id, admin-only) */
  save: adminProcedure
    .input(
      z.strictObject({
        id: storableId('id', 64).optional(),
        name: storable('name', z.string().min(1).max(64)),
        color: z.enum(['neutral', 'primary', 'success', 'warning', 'error', 'info']).default('neutral'),
        position: z.number().int().min(0).max(99),
        category: z
          .enum(['backlog', 'ready', 'working', 'paused', 'waiting_answer', 'in_review', 'done', 'cancelled'])
          .default('backlog'),
        nextIds: z.array(storableId('nextIds', 64)).max(50).default([]),
      }),
    )
    .handler(async ({ input }) => {
      const id = input.id?.trim() || uuidv7();
      if (id === 'new') throw new ORPCError('BAD_REQUEST', { message: 'reserved status id' });
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
      await db.transaction(async (tx) => {
        // STATUS-ORIGIN MEMORY LAW (#432): a CATEGORY change re-keys every reader that
        // resolves this status as a recorded block/park home (the settle flip's
        // machine-home term, the restore target) — a blocked task would then restore
        // into the wrong category and a live round would be bypassed. Refuse while a
        // BLOCKED task records it as its home; a stale reference on a non-paused row
        // (the #427 egress leftovers) is inert and never gates an edit. Name, colour
        // and position edits stay free — only the category is load-bearing.
        const existing = (
          await tx
            .select({ category: taskStatusesTable.category })
            .from(taskStatusesTable)
            .where(eq(taskStatusesTable.id, id))
        )[0];
        if (existing && existing.category !== input.category) {
          const pausedIds = (
            await tx
              .select({ id: taskStatusesTable.id })
              .from(taskStatusesTable)
              .where(eq(taskStatusesTable.category, CATEGORY.PAUSED))
          ).map((s) => s.id);
          const homes =
            pausedIds.length === 0
              ? []
              : await tx
                  .select({ id: tasksTable.id })
                  .from(tasksTable)
                  .where(
                    and(
                      inArray(tasksTable.status, pausedIds),
                      or(eq(tasksTable.preBlockStatus, id), eq(tasksTable.parkFromStatus, id)),
                    ),
                  );
          if (homes.length > 0)
            throw new ORPCError('BAD_REQUEST', {
              message: `status is the recorded home of ${homes.length} blocked task(s) — unblock them before changing its category`,
            });
        }
        // transitions must reference existing statuses (self ok) — validated against the same snapshot we upsert
        const all = await tx.query.taskStatuses.findMany({ columns: { id: true }, orderBy: { position: 'asc' } });
        const ids = new Set([...all.map((a) => a.id), id]);
        for (const n of input.nextIds) {
          if (!ids.has(n)) throw new ORPCError('BAD_REQUEST', { message: `unknown status in transitions: ${n}` });
        }
        await tx
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
      });
      await publishChange(CHANGE_RESOURCE.STATUSES, CHANGE_ACTION.UPDATE);
      return { id };
    }),

  /** delete a status: blocked while in use; prunes dangling transition edges (admin-only) */
  remove: adminProcedure.input(z.strictObject({ id: storableId('id') })).handler(async ({ input }) => {
    // seeded workflow statuses are load-bearing (code + migrations address them by id)
    if ((Object.values(STATUS) as string[]).includes(input.id)) {
      throw new ORPCError('BAD_REQUEST', { message: 'built-in status' });
    }
    await db.transaction(async (tx) => {
      // the row is the category source for the origin re-home below; a missing row is
      // the NOT_FOUND the delete used to answer (same message)
      const statusRow = (
        await tx
          .select({ id: taskStatusesTable.id, category: taskStatusesTable.category })
          .from(taskStatusesTable)
          .where(eq(taskStatusesTable.id, input.id))
      )[0];
      if (!statusRow) throw new ORPCError('NOT_FOUND', { message: 'status not found' });
      const inUse = await tx.query.tasks.findMany({
        columns: { id: true },
        where: { status: { eq: input.id } },
        orderBy: { id: 'asc' },
      });
      if (inUse.length > 0)
        throw new ORPCError('BAD_REQUEST', { message: `status is used by ${inUse.length} task(s)` });
      // STATUS-ORIGIN MEMORY LAW (#432): a recorded block/park home is a raw id with no
      // FK — deleting the row without re-homing strands every block that recorded it
      // (the settle flip's machine-home term stops matching, the round closes with no
      // task write, the restore falls the unknown id back to to-do). Re-home EVERY
      // recorded reference in this same transaction, before the row disappears; the
      // category has to survive the move, so one without a built-in status refuses.
      // Stale references on non-paused rows (#427 egress leftovers) ride along: they
      // are inert drift, and leaving them would state a home that no longer exists.
      const refs = await tx
        .select({ id: tasksTable.id })
        .from(tasksTable)
        .where(or(eq(tasksTable.preBlockStatus, input.id), eq(tasksTable.parkFromStatus, input.id)));
      if (refs.length > 0) {
        // the canonical target must still CARRY the category — an admin can recategorize
        // a built-in, and a frozen id map would then re-home into the wrong category
        const homeId = CANONICAL_BY_CATEGORY[statusRow.category];
        const liveHome = homeId
          ? (
              await tx
                .select({ category: taskStatusesTable.category })
                .from(taskStatusesTable)
                .where(eq(taskStatusesTable.id, homeId))
            )[0]
          : undefined;
        const home = liveHome && liveHome.category === statusRow.category ? homeId : null;
        if (!home)
          throw new ORPCError('BAD_REQUEST', {
            message: `status is the recorded home of ${refs.length} task(s) and category '${statusRow.category}' has no faithful built-in home`,
          });
        // METADATA REPAIR, not a task write: the stamp is HELD BACK (`updated_at =
        // updated_at`). Bumping it would invalidate an in-flight settle flip that pinned
        // the stamp it read (0-row CAS, the round closes with no task write — the exact
        // strand this law removes) and would mask the #430 wedge discriminator
        // (`verdict > updated_at`) on a row the repair touched.
        await tx
          .update(tasksTable)
          .set({ preBlockStatus: home, updatedAt: sql`updated_at` })
          .where(eq(tasksTable.preBlockStatus, input.id));
        await tx
          .update(tasksTable)
          .set({ parkFromStatus: home, updatedAt: sql`updated_at` })
          .where(eq(tasksTable.parkFromStatus, input.id));
      }
      const del = await tx
        .delete(taskStatusesTable)
        .where(eq(taskStatusesTable.id, input.id))
        .returning({ id: taskStatusesTable.id });
      if (del.length === 0) throw new ORPCError('NOT_FOUND', { message: 'status not found' });
      // edges pointing at the removed status would become dead transitions — strip them atomically
      const others = await tx.query.taskStatuses.findMany({
        columns: { id: true, nextIds: true },
        orderBy: { position: 'asc' },
      });
      for (const o of others) {
        if (!o.nextIds.includes(input.id)) continue;
        await tx
          .update(taskStatusesTable)
          .set({ nextIds: o.nextIds.filter((n) => n !== input.id), updatedAt: new Date() })
          .where(eq(taskStatusesTable.id, o.id));
      }
    });
    await publishChange(CHANGE_RESOURCE.STATUSES, CHANGE_ACTION.UPDATE);
    return { ok: true };
  }),

  /** auto-assign a task via Jev (typed choice over employee candidates).
   *  No-op when a Jev key isn't configured or Jev is unsure — the task
   *  stays unassigned for a human decision. */
  assign: employeeProcedure
    .input(z.strictObject({ taskId: storableIdRef('taskId') }))
    .handler(async ({ input, context }) => {
      const tRows = await db.query.tasks.findMany({
        columns: { id: true, title: true, description: true, projectId: true },
        where: { id: { eq: input.taskId } },
        orderBy: { id: 'asc' },
      });
      const task = tRows[0];
      if (!task) throw new ORPCError('NOT_FOUND', { message: 'task not found' });
      // RUN LOCK (#264): a live run owns the assignee — the auto path obeys the
      // same lock as tasks.update (SPEC: assignee edits are rejected server-side)
      const { runningRunIdForTask } = await import('../tasks/runner.service');
      if (await runningRunIdForTask(task.id))
        throw new ORPCError('BAD_REQUEST', { message: 'task is running — assignee is locked until it settles' });
      // candidates: every employee, with open-task load (non-terminal statuses)
      const users = await db.query.user.findMany({
        columns: { id: true, name: true, title: true },
        orderBy: { id: 'asc' },
      });
      const aiRows = await db.query.aiEmployees.findMany({ columns: { userId: true }, orderBy: { userId: 'asc' } });
      const aiByUser = new Map(aiRows.map((r) => [r.userId, r]));
      const statusRows = await db.query.taskStatuses.findMany({
        columns: { id: true, category: true },
        orderBy: { position: 'asc' },
      });
      const terminal = new Set(
        statusRows.filter((s) => s.category === 'done' || s.category === 'cancelled').map((s) => s.id),
      );
      const allTasks = await db.query.tasks.findMany({
        columns: { assigneeId: true, status: true },
        orderBy: { id: 'asc' },
      });
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
        projName = projRows.length > 0 ? nonNull(projRows[0]).name : null;
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
      // route through the ledger writer — a raw assigneeId update would leave the
      // assignment history with no row for this move
      // RUN LOCK re-check (#264 r4): the decision call above can take seconds —
      // a run starting mid-decision must not get its assignee swapped on landing
      if (await runningRunIdForTask(task.id))
        throw new ORPCError('BAD_REQUEST', { message: 'task is running — assignee is locked until it settles' });
      const { assignTask } = await import('../tasks/assignments.service');
      const session = await (
        context as unknown as { getSession: () => Promise<{ user: { id: string } } | null> }
      ).getSession();
      await assignTask(task.id, result.employeeId, 'auto', session?.user?.id ?? null);
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
