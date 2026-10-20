// Dispatcher: scans for eligible tasks (ready-category status + AI assignee)
// and dispatches them to the runner. One task at a time per agent (serial);
// extra ready tasks queue until the agent is idle. Intended to run on a
// server-side interval (boot plugin), skippable in tests via env.
import { eq } from 'drizzle-orm';

import { STATUS } from '#shared/status';

import { db } from '../../db';
import { tasks, taskRuns, taskStatuses, aiEmployees } from '../../db/schema';
import { publishChange } from '../kernel/change-bus';
import { redisHub } from '../kernel/redis';
import { dispatchTask } from './runner.service';

const inFlight = new Map<string, Set<Promise<unknown>>>(); // employeeId -> live run promises

export function activeRunCount(): number {
  let n = 0;
  for (const set of inFlight.values()) n += set.size;
  return n;
}

/** how many runs of one agent are in flight right now (no-redis fallback) */
export function inFlightCount(employeeId: string): number {
  return inFlight.get(employeeId)?.size ?? 0;
}

function trackInFlight(employeeId: string, p: Promise<unknown>) {
  let set = inFlight.get(employeeId);
  if (!set) {
    set = new Set();
    inFlight.set(employeeId, set);
  }
  set.add(p);
  void p.finally(() => {
    const s = inFlight.get(employeeId);
    /* v8 ignore next 1 -- two same-agent runs can settle in one microtask; the key is already gone */
    if (!s) return;
    s.delete(p);
    if (s.size === 0) inFlight.delete(employeeId);
  });
}

/** reap runs stuck in 'running' past the hard timeout + grace: mark failed, bounce task to
 * ready (with the normal backoff ladder), so orphaned rows never pin a task in doing forever. */
export async function reapStaleRuns(): Promise<number> {
  try {
    return await reapStaleRunsInner();
  } catch {
    return 0; // best-effort sweep: a failed DB read just means try again next tick
  }
}

async function reapStaleRunsInner(): Promise<number> {
  const { getRunTimeoutMs } = await import('../settings/settings.service');
  const grace = 2 * 60_000;
  const cutoff = new Date(Date.now() - (await getRunTimeoutMs()) - grace);
  const stale = await db.select().from(taskRuns).where(eq(taskRuns.status, 'running'));
  let reaped = 0;
  for (const run of stale) {
    if (run.startedAt.getTime() > cutoff.getTime()) continue;
    await db
      .update(taskRuns)
      .set({
        status: 'failed',
        exitCode: null,
        output: run.output
          ? `${run.output}\n[reaper] run timed out after ${Math.round((Date.now() - run.startedAt.getTime()) / 60_000)} min`
          : '[reaper] run timed out',
        finishedAt: new Date(),
      })
      .where(eq(taskRuns.id, run.id));
    // only bounce the task if this was its latest run
    const latest = await db.select().from(taskRuns).where(eq(taskRuns.taskId, run.taskId));
    const newest = latest.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
    if (newest?.id === run.id) {
      // FK cascade: a present run implies its task row exists
      const current = (await db.select().from(tasks).where(eq(tasks.id, run.taskId)))[0]!;
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
        .where(eq(tasks.id, run.taskId));
    }
    await publishChange('runs', 'update');
    await publishChange('tasks', 'update');
    reaped += 1;
  }
  return reaped;
}

/** find one eligible task: ready-category status, AI assignee, agent under its cap.
 * CAP LAW (2026-10-16): one concurrent task per agent by default; the Settings page's
 * tasksPerAgent raises it. Agents run in PARALLEL — the cap is per agent, never global. */
export async function findEligible(): Promise<{ taskId: string; employeeId: string } | null> {
  const statuses = await db.select().from(taskStatuses);
  const readyIds = statuses.filter((s) => s.category === 'ready').map((s) => s.id);
  if (readyIds.length === 0) return null;
  const { getTasksPerAgent } = await import('../settings/settings.service');
  const cap = await getTasksPerAgent();
  const rows = await db.select().from(tasks);
  const aiRows = await db.select({ userId: aiEmployees.userId }).from(aiEmployees);
  const aiIds = new Set(aiRows.map((r) => r.userId));
  const now = Date.now();
  const eligible = rows
    .filter((t) => readyIds.includes(t.status) && t.assigneeId && aiIds.has(t.assigneeId))
    // per-agent concurrency cap (in-memory slot count; the redis path counts its own workers)
    .filter((t) => inFlightCount(t.assigneeId!) < cap)
    // failure backoff: not claimable until dispatch_after passes (null = immediately)
    .filter((t) => !t.dispatchAfter || t.dispatchAfter.getTime() <= now)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const first = eligible[0];
  return first ? { taskId: first.id, employeeId: first.assigneeId! } : null;
}

/** one scan step: claim + dispatch at most one task. Returns true if dispatched. */
export async function scanOnce(tandemUrl: string): Promise<boolean> {
  const hit = await findEligible();
  if (!hit) return false;
  const hub = await redisHub();
  if (hub) {
    try {
      /* v8 ignore next -- lazy resync; the catch arrow only fires on a redis failure */
      void syncDispatchWorkers(hub).catch(() => {});
      // jobId = taskId: while a dispatch for this task waits or runs, duplicate
      // enqueues (scanner ticks during a worker backlog) are rejected by bullmq
      await hub.enqueue<DispatchJob>(
        dispatchQueueName(hit.employeeId),
        { taskId: hit.taskId, tandemUrl },
        { attempts: 3, jobId: hit.taskId, removeOnComplete: true },
      );
      return true;
    } catch (e) {
      console.warn('[tandem] dispatch enqueue failed, retrying next scan:', (e as Error).message);
      return false; // redis hiccup: try next scan
    }
  }
  try {
    const handle = await dispatchTask(hit.taskId, tandemUrl);
    trackInFlight(hit.employeeId, handle.finished);
    return true;
  } catch {
    // dispatchTask validates its own preconditions; misses just mean "try next scan"
    return false;
  }
}

/** per-agent dispatch queue name (bullmq forbids ':' in queue names) */
export function dispatchQueueName(employeeId: string): string {
  return `${DISPATCH_QUEUE_PREFIX}-${employeeId}`;
}

export const DISPATCH_QUEUE_PREFIX = 'tandem-dispatch';

export type DispatchJob = { taskId: string; tandemUrl: string };

/** live per-agent workers: agentId -> { concurrency, close } */
const workers = new Map<string, { concurrency: number; close: () => Promise<void> }>();

/** spawn one worker per AI employee at the current tasksPerAgent cap; recreate
 * any whose concurrency is stale (setting changed) and drop the ones whose
 * employee row is gone. Idempotent — safe to call on every sweep. */
/** a queued job may be STALE (task already running/done/waiting — duplicates could
 * stack while the worker was busy). The worker skips ineligible tasks quietly: no
 * re-run, no retry storm, no status flip back to doing. */
export async function dispatchIfEligible(taskId: string, tandemUrl: string): Promise<void> {
  const statuses = await db.select().from(taskStatuses);
  const readyIds = new Set(statuses.filter((s) => s.category === 'ready').map((s) => s.id));
  const row = (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)))[0];
  if (!row || !readyIds.has(row.status)) return; // stale duplicate: skip
  const run = await dispatchTask(taskId, tandemUrl);
  await run.finished;
}

export async function syncDispatchWorkers(hub: NonNullable<Awaited<ReturnType<typeof redisHub>>>): Promise<void> {
  const { getTasksPerAgent } = await import('../settings/settings.service');
  const cap = await getTasksPerAgent();
  const aiRows = await db.select({ userId: aiEmployees.userId }).from(aiEmployees);
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
      async (job) => {
        await dispatchIfEligible(job.taskId, job.tandemUrl); // stale jobs no-op
      },
      { concurrency: cap, attempts: 3 },
    );
    workers.set(agentId, { concurrency: cap, close: handle.close });
  }
}

/** settings.update calls this so a tasksPerAgent change applies without a redeploy.
 * Best-effort: no redis or a resync failure must never fail the settings write. */
export async function onDispatcherSettingsChanged(): Promise<void> {
  try {
    const hub = await redisHub();
    if (!hub) return;
    await syncDispatchWorkers(hub);
  } catch (e) {
    console.warn('[tandem] dispatch worker resync failed:', (e as Error).message);
  }
}

/** boot hook: start the dispatcher unless opted out (tests set TANDEM_NO_DISPATCHER=1).
 * With REDIS_URL set, dispatch flows through BullMQ PER-AGENT queues (durable,
 * exponential-backoff retries) — one worker per AI employee, concurrency =
 * tasksPerAgent (default 1). Agents run in parallel; the scan loop still runs as a
 * sweep for tasks queued while redis was down. */
export async function maybeStartDispatcher(): Promise<(() => void) | null> {
  if (process.env.TANDEM_NO_DISPATCHER) return null;
  const url = process.env.TANDEM_PUBLIC_URL || 'http://localhost:3000';
  const hub = await redisHub();
  if (hub) {
    await syncDispatchWorkers(hub);
    console.log(`[tandem] dispatch queue workers started (redis, per-agent)`);
  }
  const stop = startDispatcher(url);
  console.log(`[tandem] dispatcher started (${hub ? 'redis+interval' : 'interval'})`);
  return stop;
}

/** start the interval; returns a stop function */
export function startDispatcher(tandemUrl: string, intervalMs = 5000): () => void {
  const timer = setInterval(() => {
    void scanOnce(tandemUrl); // scanOnce never rejects: its own catch turns errors into false
    void reapStaleRuns(); // never rejects: its own catch turns errors into 0 reaped
  }, intervalMs);
  return () => clearInterval(timer);
}

/** runs lookup used by the router */
export { listRuns } from './runner.service';
export { taskRuns } from '../../db/schema';
