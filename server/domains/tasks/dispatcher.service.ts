import { consola } from 'consola';
import { and, desc, eq } from 'drizzle-orm';

import { ACTIVITY_KIND, CHANGE_RESOURCE, CHANGE_ACTION, RUN_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';
// Dispatcher: scans for eligible tasks (ready-category status + AI assignee)
// and dispatches them to the runner. One task at a time per agent (serial);
// extra ready tasks queue until the agent is idle. Intended to run on a
// server-side interval (boot plugin), skippable in tests via env.
import { nonNull } from '#shared/utils/non-null';

import { db } from '../../db/index';
import { aiEmployees, tasks, taskRuns, taskMessages, taskStatuses } from '../../db/schema';
import { publishChange } from '../kernel/change-bus';
import { env } from '../kernel/env';
import { redisQueue } from '../kernel/queue';
import {
  DISPATCH_ATTEMPTS,
  dispatchQueueName,
  backoffFor,
  dispatchTask,
  executeRun,
  type DispatchJob,
} from './runner.service';

const log = consola.withTag('tandem');

/** reap runs stuck in 'running' past the hard timeout + grace: mark failed, bounce task to
 * ready (with the normal backoff ladder), so orphaned rows never pin a task in doing forever. */
export async function reapStaleRuns() {
  try {
    return await reapStaleRunsInner();
  } catch {
    return 0; // best-effort sweep: a failed DB read just means try again next tick
  }
}

async function reapStaleRunsInner() {
  const { getRunTimeoutMs } = await import('../settings/settings.service');
  const grace = 2 * 60_000;
  const cutoff = new Date(Date.now() - (await getRunTimeoutMs()) - grace);
  const stale = await db.query.taskRuns.findMany({
    columns: { id: true, output: true, startedAt: true },
    where: { status: { eq: RUN_STATUS.RUNNING } },
    orderBy: { startedAt: 'asc' },
    with: { message: { columns: { taskId: true } } },
  });
  let reaped = 0;
  for (const run of stale) {
    if (run.startedAt.getTime() > cutoff.getTime()) continue;
    const reapedRows = await db
      .update(taskRuns)
      .set({
        status: RUN_STATUS.FAILED,
        exitCode: null,
        output: run.output
          ? `${run.output}\n[reaper] run timed out after ${Math.round((Date.now() - run.startedAt.getTime()) / 60_000)} min`
          : '[reaper] run timed out',
        finishedAt: new Date(),
      })
      // RUNNING predicate: a run that just settled (finish() flipped it) must never
      // be overwritten by a reaper sweep that read the stale RUNNING list
      .where(and(eq(taskRuns.id, run.id), eq(taskRuns.status, RUN_STATUS.RUNNING)))
      .returning({ id: taskRuns.id });
    if (!reapedRows.length) continue; // settled concurrently — nothing to reap
    // only bounce the task if this was its latest run
    const latest = await db
      .select({ id: taskRuns.id, startedAt: taskRuns.startedAt })
      .from(taskRuns)
      .innerJoin(taskMessages, eq(taskMessages.id, taskRuns.messageId))
      .where(eq(taskMessages.taskId, nonNull(run.message).taskId));
    const newest = latest.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
    if (newest?.id === run.id) {
      const taskId = nonNull(run.message).taskId;
      // FK cascade: a present run implies its task row exists
      const current = nonNull(
        (
          await db.query.tasks.findMany({
            columns: { failStreak: true },
            where: { id: { eq: taskId } },
            orderBy: { createdAt: 'asc' },
          })
        )[0],
      );
      const streak = current.failStreak + 1;
      const waitMs = 15 * 60_000; // timeout = worst tier; something is wrong with the agent
      await db
        .update(tasks)
        .set({
          status: STATUS.todo,
          failStreak: streak,
          dispatchAfter: new Date(Date.now() + waitMs),
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));
    }
    await publishChange(CHANGE_RESOURCE.RUNS, CHANGE_ACTION.UPDATE);
    await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
    reaped += 1;
  }
  return reaped;
}

/** LIVENESS SWEEP (#88, 2026-10-31): a working-category task is backed by a live run
 * or it bounces to ready. Covers subtask-unblock relics, missed status remaps and
 * settle-path regressions — shapes the reaper cannot see (it only reaps stale RUNNING
 * rows). Liveness repair, not failure: fail_streak/dispatch_after untouched, no backoff;
 * human-assigned tasks are exempt (manual status freedom). */
export const LIVENESS_GRACE_MS = 15 * 60_000;

/** pure sweep decision: bounce iff working + AI assignee + no live run + idle past grace */
export function livenessBounce(
  t: {
    category: string | null;
    isAiAssignee: boolean;
    newestRunStatus: string | null;
    newestRunSettledAt: Date | null;
    updatedAt: Date;
  },
  now: number,
  graceMs = LIVENESS_GRACE_MS,
): boolean {
  if (t.category !== 'working' || !t.isAiAssignee) return false;
  if (t.newestRunStatus === RUN_STATUS.RUNNING) return false;
  // a run that just settled is mid-settle flow (synchronous); updatedAt backs the
  // zero-run shape (manual move / data relic) and settled runs missing finished_at
  const idleSince = t.newestRunSettledAt ?? t.updatedAt;
  return now - idleSince.getTime() > graceMs;
}

export async function sweepIdleWorking(): Promise<number> {
  try {
    return await sweepIdleWorkingInner();
  } catch (e) {
    log.warn('liveness sweep failed:', (e as Error).message);
    return 0; // best-effort sweep: try again next tick
  }
}

async function sweepIdleWorkingInner(): Promise<number> {
  const now = Date.now();
  const rows = await db
    .select({ id: tasks.id, updatedAt: tasks.updatedAt })
    .from(tasks)
    .innerJoin(taskStatuses, eq(taskStatuses.id, tasks.status))
    .innerJoin(aiEmployees, eq(aiEmployees.userId, tasks.assigneeId))
    .where(eq(taskStatuses.category, 'working'));
  let bounced = 0;
  for (const row of rows) {
    // runs link tasks via task_runs.message_id -> task_messages.task_id (no task_id on runs)
    const newest = (
      await db
        .select({ status: taskRuns.status, finishedAt: taskRuns.finishedAt })
        .from(taskRuns)
        .innerJoin(taskMessages, eq(taskMessages.id, taskRuns.messageId))
        .where(eq(taskMessages.taskId, row.id))
        .orderBy(desc(taskRuns.startedAt))
        .limit(1)
    )[0];
    if (
      !livenessBounce(
        {
          category: 'working',
          isAiAssignee: true,
          newestRunStatus: newest?.status ?? null,
          newestRunSettledAt: newest?.finishedAt ?? null,
          updatedAt: row.updatedAt,
        },
        now,
      )
    )
      continue;
    await db
      .update(tasks)
      .set({ status: STATUS.todo, dispatchAfter: null, updatedAt: new Date() })
      .where(eq(tasks.id, row.id));
    const { logActivity } = await import('./review.service');
    await logActivity(
      row.id,
      ACTIVITY_KIND.STATUS,
      null,
      '[liveness] idle in a working status with no live run — returned to to-do',
      { livenessBounce: true, idleSince: (newest?.finishedAt ?? row.updatedAt).toISOString() },
    );
    await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
    bounced += 1;
  }
  if (bounced > 0) log.info(`liveness sweep: ${bounced} idle working task(s) back to to-do`);
  return bounced;
}

/** the per-agent cap; dynamic import keeps the settings domain out of the
 * dispatcher's static graph */
async function tasksPerAgentCap(): Promise<number> {
  const { getTasksPerAgent } = await import('../settings/settings.service');
  return await getTasksPerAgent();
}

/** pure cap decision: an agent at/over its live-run cap claims nothing (CAP LAW 2026-10-16) */
export function atCap(liveRuns: number, cap: number): boolean {
  return liveRuns >= cap;
}

/** live RUNNING run count for one employee across all their tasks — the cap is per
 * agent, so the dispatcher must know how many turns an agent already owns */
export async function liveRunCountFor(employeeId: string): Promise<number> {
  return await db.query.taskRuns.count({ employeeId: { eq: employeeId }, status: { eq: RUN_STATUS.RUNNING } });
}

/** find one eligible task: ready-category status, AI assignee, backoff elapsed,
 * agent under its cap (oldest first).
 * CAP LAW (2026-10-16): one concurrent task per agent by default; the Settings page's
 * tasksPerAgent raises it. Agents run in PARALLEL — the cap is per agent, never global.
 * The cap is checked HERE at claim time, not left to queue concurrency: a dispatch
 * claim (run row RUNNING + task doing) must never outrun the agent's slot count. */
export async function findEligible(): Promise<{ taskId: string; employeeId: string } | null> {
  const statuses = await db.query.taskStatuses.findMany({
    columns: { id: true, category: true },
    orderBy: { position: 'asc' },
  });
  const readyIds = statuses.filter((s) => s.category === 'ready').map((s) => s.id);
  if (readyIds.length === 0) return null;

  const rows = await db.query.tasks.findMany({
    columns: { id: true, status: true, assigneeId: true, dispatchAfter: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const aiRows = await db.query.aiEmployees.findMany({ columns: { userId: true }, orderBy: { userId: 'asc' } });
  const aiIds = new Set(aiRows.map((r) => r.userId));
  const cap = await tasksPerAgentCap();
  const now = Date.now();
  const eligible = rows
    .filter((t) => readyIds.includes(t.status) && t.assigneeId && aiIds.has(t.assigneeId))
    // failure backoff: not claimable until dispatch_after passes (null = immediately)
    .filter((t) => !t.dispatchAfter || t.dispatchAfter.getTime() <= now)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const t of eligible) {
    const employeeId = nonNull(t.assigneeId);
    if (atCap(await liveRunCountFor(employeeId), cap)) continue;
    return { taskId: t.id, employeeId };
  }
  return null;
}

/** one scan step: claim + dispatch at most one task. Returns true if dispatched.
 * The run row (frozen brief) is created HERE and the job carries its id — retries
 * replay the run, they never rebuild it (run-level retry law, 2026-10-28). */
export async function scanOnce(tandemUrl: string) {
  const hit = await findEligible();
  if (!hit) return false;
  try {
    const hub = await redisQueue();
    /* v8 ignore next -- lazy resync; the catch arrow only fires on a redis failure */
    void syncDispatchWorkers(hub).catch(() => {}); // workers may not exist yet (first dispatch after boot)
    await dispatchTask(hit.taskId, tandemUrl);
    return true;
  } catch (e) {
    log.warn('dispatch failed, retrying next scan:', (e as Error).message);
    return false; // redis hiccup or plan failure: try next scan
  }
}

// queue naming + job payload live in runner.service (next to the run they carry);
// re-exported here for the boot plugin and tests
export { dispatchQueueName, DISPATCH_QUEUE_PREFIX } from './runner.service';
export type { DispatchJob } from './runner.service';

/** live per-agent workers: agentId -> { concurrency, close } */
const workers = new Map<string, { concurrency: number; close: () => Promise<void> }>();

/** the effective cap the workers are currently synced to — window-flip detection
 * compares the live cap against this each scan tick */

/** a stale dispatch call (task already running/done/waiting) must quietly no-op: no
 * re-run, no retry storm, no status flip. */
export async function dispatchIfEligible(taskId: string, tandemUrl: string) {
  const statuses = await db.query.taskStatuses.findMany({
    columns: { id: true, category: true },
    orderBy: { position: 'asc' },
  });
  const readyIds = new Set(statuses.filter((s) => s.category === 'ready').map((s) => s.id));
  const row = await db.query.tasks.findFirst({
    columns: { status: true, dispatchAfter: true, assigneeId: true },
    where: { id: { eq: taskId } },
  });
  if (!row || !readyIds.has(row.status)) return; // stale duplicate: skip
  // backoff law: a dispatch call must not bypass the failure backoff the runner set —
  // the scan loop respects dispatch_after; the direct path has to as well
  if (row.dispatchAfter && row.dispatchAfter.getTime() > Date.now()) return;
  // CAP LAW: the direct path obeys the same per-agent cap as the scan — a busy agent
  // gains no second claim because a human typed at the right moment. The scan picks
  // the task up as soon as a slot frees.
  if (row.assigneeId && atCap(await liveRunCountFor(row.assigneeId), await tasksPerAgentCap())) return;
  // returns after enqueue — the per-agent worker executes the run (composer law:
  // submitting dispatches the run; the RPC never rides the turn)
  await dispatchTask(taskId, tandemUrl);
}

/** the retry-delay ladder for run-level transport retries: same steps as the
 * task-level backoff, keyed by the FAILED attempt number, with the quota jump
 * reading the run's appended error output. */
async function dispatchBackoffDelay(failedAttempt: number, runId: string): Promise<number> {
  const row = await db.query.taskRuns.findFirst({ columns: { output: true }, where: { id: { eq: runId } } });
  return backoffFor(failedAttempt, row?.output ?? '');
}

export async function syncDispatchWorkers(hub: NonNullable<Awaited<ReturnType<typeof redisQueue>>>) {
  const cap = await tasksPerAgentCap();
  const aiRows = await db.query.aiEmployees.findMany({ columns: { userId: true }, orderBy: { userId: 'asc' } });
  const wanted = new Set(aiRows.map((r) => r.userId));
  for (const [agentId, w] of workers) {
    if (!wanted.has(agentId) || w.concurrency !== cap) {
      await w.close();
      workers.delete(agentId);
    }
  }
  for (const agentId of wanted) {
    const existing = workers.get(agentId);
    if (existing?.concurrency === cap) continue;
    const handle = await hub.queue<DispatchJob>(
      dispatchQueueName(agentId),
      async (job, meta) => {
        // stale guard lives on the RUN row: settled (cancelled/reaped) mid-backoff
        // rows make later attempts no-op inside executeRun
        await executeRun(job.runId, job.tandemUrl, {
          attempt: meta.attempt,
          maxAttempts: meta.maxAttempts,
          reviewBy: job.reviewBy,
          resultBody: job.resultBody,
        });
      },
      {
        concurrency: cap,
        attempts: DISPATCH_ATTEMPTS,
        backoffStrategy: (failedAttempt, _type, _err, job) =>
          dispatchBackoffDelay(failedAttempt, (job.data as DispatchJob).runId),
      },
    );
    workers.set(agentId, { concurrency: cap, close: handle.close });
  }
}

/** settings.update calls this so a tasksPerAgent change applies without a redeploy.
 * Best-effort: no redis or a resync failure must never fail the settings write. */
export async function onDispatcherSettingsChanged() {
  try {
    const hub = await redisQueue();
    await syncDispatchWorkers(hub);
  } catch (e) {
    log.warn('dispatch worker resync failed:', (e as Error).message);
  }
}

/** boot hook: start the dispatcher unless opted out (tests set TANDEM_NO_DISPATCHER=1).
 * With REDIS_URL set, dispatch flows through BullMQ PER-AGENT queues (durable,
 * exponential-backoff retries) — one worker per AI employee, concurrency = the
 * per-agent cap (tasksPerAgent). Agents run in parallel; the scan loop still
 * runs as a sweep for tasks queued while redis was down. */
export async function maybeStartDispatcher(): Promise<(() => void) | null> {
  if (env.TANDEM_NO_DISPATCHER) return null;
  const url = env.TANDEM_PUBLIC_URL ?? 'http://localhost:3000';
  const hub = await redisQueue();
  await syncDispatchWorkers(hub);
  log.success('dispatch queue workers started (redis, per-agent)');
  const stop = startDispatcher(url);
  log.success('dispatcher started (redis+interval)');
  return stop;
}

/** start the interval; returns a stop function */
export function startDispatcher(tandemUrl: string, intervalMs = 5000): () => void {
  const timer = setInterval(() => {
    void scanOnce(tandemUrl); // scanOnce never rejects: its own catch turns errors into false
    void reapStaleRuns(); // never rejects: its own catch turns errors into 0 reaped
    void sweepIdleWorking(); // never rejects: its own catch turns errors into 0 bounced
  }, intervalMs);
  return () => clearInterval(timer);
}

/** runs lookup used by the router */
export { listRuns } from './runner.service';
export { taskRuns } from '../../db/schema';
