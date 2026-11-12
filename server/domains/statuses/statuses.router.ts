import { os } from '@orpc/server';
import { consola } from 'consola';
// statuses router — business logic lives in services/utils; this file only wires procedures
import { and, asc, eq, ne, or, sql } from 'drizzle-orm';
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

const log = consola.withTag('tandem');

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
        // STATUS MUTATION MUTEX (#432): every writer of task_statuses (this upsert, the
        // removal and its origin re-home) serializes on ONE transaction-scoped advisory
        // lock, so a category edit can never interleave with a delete's re-home (a save
        // racing the re-home TARGET would otherwise re-categorize a home that just
        // landed) and two same-category removals can never deadlock on each other's
        // target row.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('tandem:task_statuses'))`);
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
        // THE BLOCK STATE'S CATEGORY IS FROZEN (#432): it is the anchor every recorded
        // machine home restores through and every paused-category discriminator resolves
        // (the settle flip's paused branch, the mint gate, both sweeps, both probe arms).
        // A recategorized block state re-keys or blinds ALL of them at once (blocked rows
        // become dispatchable at Blocked→ready, terminal at Blocked→done), so only name,
        // colour and position stay editable on it.
        if (existing && id === STATUS.blocked && existing.category !== input.category)
          throw new ORPCError('BAD_REQUEST', {
            message: 'the block state category is fixed — name, colour and position stay editable',
          });
        if (existing && existing.category !== input.category) {
          // the blocker is the BLOCK STATE by IDENTITY, never the paused CATEGORY: the
          // gating arms fire on status === BLOCKED_STATUS, and no live writer leaves an
          // origin on any other row, so identity is the load-bearing test.
          const homes = await tx
            .select({ id: tasksTable.id })
            .from(tasksTable)
            .where(
              and(
                eq(tasksTable.status, STATUS.blocked),
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
    const touched = await db.transaction(async (tx) => {
      // STATUS MUTATION MUTEX (#432): see save — the category read below must not drift
      // under a concurrent edit, and two same-category removals must not deadlock.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('tandem:task_statuses'))`);
      // a missing row is the NOT_FOUND the delete always answered
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
      // task write, the restore falls the unknown id back). Resolve a FAITHFUL target
      // LIVE, by category: a frozen id map would re-home into the wrong category after
      // an admin recategorizes a built-in, and would miss a category that gained a row.
      // 'paused' has NO faithful target: a restore into ANY paused-category status
      // clears the origin and leaves a row no gating arm fires on (the block state
      // themselves is excluded by identity below, so no paused candidate survives).
      const refs = await tx
        .select({ id: tasksTable.id, status: tasksTable.status })
        .from(tasksTable)
        .where(or(eq(tasksTable.preBlockStatus, input.id), eq(tasksTable.parkFromStatus, input.id)))
        // FOR UPDATE: hold the referencing rows so a concurrent gating block waits for
        // this delete instead of landing a home behind it
        .for('update');
      // A FAITHFUL target carries the same category AND is not the block state itself
      // (by IDENTITY: a home re-homed onto BLOCKED restores the task INTO the block,
      // clears both origins and strands it), and 'paused' has none — a restore into any
      // paused status clears the origin and leaves a row no arm can fire.
      let home: string | null = null;
      if (statusRow.category !== CATEGORY.PAUSED) {
        const candidates = await tx
          .select({ id: taskStatusesTable.id })
          .from(taskStatusesTable)
          .where(
            and(
              eq(taskStatusesTable.category, statusRow.category),
              ne(taskStatusesTable.id, input.id),
              ne(taskStatusesTable.id, STATUS.blocked),
            ),
          )
          .orderBy(asc(taskStatusesTable.position))
          .limit(1);
        home = candidates[0]?.id ?? null;
      }
      // only a LOAD-BEARING reference can refuse: one held by a BLOCKED task (by
      // IDENTITY — the only state a gating block/park ever writes, and the only state
      // every reader fires on). An inert leftover on any other row (#427 egress) means
      // nothing to any reader, so it is CLEARED instead of making the status undeletable
      // forever with no in-product remedy.
      const liveRefs = refs.filter((r) => r.status === STATUS.blocked).length;
      if (!home && liveRefs > 0)
        throw new ORPCError('BAD_REQUEST', {
          message: `status is the recorded home of ${liveRefs} blocked task(s) and category '${statusRow.category}' has no faithful home`,
        });
      const del = await tx
        .delete(taskStatusesTable)
        .where(eq(taskStatusesTable.id, input.id))
        .returning({ id: taskStatusesTable.id });
      if (del.length === 0) throw new ORPCError('NOT_FOUND', { message: 'status not found' });
      // REPAIR AFTER THE DELETE, in the same transaction: the UPDATE's own WHERE catches a
      // block/park that committed inside the refs-read→delete window (READ COMMITTED
      // re-evaluates at execution), so only a write landing after this statement can
      // still name the removed row — a task moved into a status being deleted is the
      // pre-existing ghost-task race the in-use check above already carries.
      // The stamp is HELD BACK (`updated_at = updated_at`): this is metadata repair, and
      // a bumped stamp would miss an in-flight settle flip's CAS (the exact strand this
      // law removes) and mask the #430 wedge discriminator (`verdict > updated_at`).
      // UNCONDITIONAL (not gated on the refs read): a block/park that committed inside
      // the refs-read→delete window is caught by this UPDATE's own WHERE, so the repair
      // is right even when the read saw zero references.
      const touched = new Set<string>();
      const collect = (rows: Array<{ id: string }>) => {
        for (const r of rows) touched.add(r.id);
      };
      if (home) {
        collect(
          await tx
            .update(tasksTable)
            .set({ preBlockStatus: home, updatedAt: sql`updated_at` })
            .where(eq(tasksTable.preBlockStatus, input.id))
            .returning({ id: tasksTable.id }),
        );
        collect(
          await tx
            .update(tasksTable)
            .set({ parkFromStatus: home, updatedAt: sql`updated_at` })
            .where(eq(tasksTable.parkFromStatus, input.id))
            .returning({ id: tasksTable.id }),
        );
      } else {
        // no faithful home: drop the INERT references (a blocked one would have refused)
        collect(
          await tx
            .update(tasksTable)
            .set({ preBlockStatus: null, updatedAt: sql`updated_at` })
            .where(and(eq(tasksTable.preBlockStatus, input.id), ne(tasksTable.status, STATUS.blocked)))
            .returning({ id: tasksTable.id }),
        );
        collect(
          await tx
            .update(tasksTable)
            .set({ parkFromStatus: null, updatedAt: sql`updated_at` })
            .where(and(eq(tasksTable.parkFromStatus, input.id), ne(tasksTable.status, STATUS.blocked)))
            .returning({ id: tasksTable.id }),
        );
      }
      // the invariant the whole law rests on: after this delete no row may still name the
      // removed id. A reference that landed after the repair statement is the ghost-task
      // race (a task moved into a status being deleted) — roll the delete back and let the
      // caller retry against the settled state instead of shipping a dangling home.
      const stragglers = await tx
        .select({ id: tasksTable.id })
        .from(tasksTable)
        .where(or(eq(tasksTable.preBlockStatus, input.id), eq(tasksTable.parkFromStatus, input.id)))
        .limit(1);
      if (stragglers.length > 0)
        throw new ORPCError('BAD_REQUEST', {
          message: 'status changed while it was being removed — a task now records it as its home; retry',
        });
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
      return [...touched];
    });
    await publishChange(CHANGE_RESOURCE.STATUSES, CHANGE_ACTION.UPDATE);
    // BEST-EFFORT AFTER THE COMMIT (#432): the repair changed restore targets, so re-derive
    // the gating of every touched task — a task whose children all landed while it was
    // blocked restores onto its NEW home now instead of waiting for an unrelated write
    // (a restore that raced this delete lost its CAS on the pinned origin and cannot).
    // The outcome stands either way; a gating failure is logged, never surfaced.
    for (const taskId of touched) {
      try {
        const { refreshParentGating } = await import('../tasks/gating.service');
        await refreshParentGating(taskId);
      } catch (e) {
        log.warn(`statuses: re-gate after the origin repair failed for ${taskId}:`, e instanceof Error ? e.message : e);
      }
    }
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
