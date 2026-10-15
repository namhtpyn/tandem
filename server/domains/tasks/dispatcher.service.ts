// Dispatcher: scans for eligible tasks (ready-category status + AI assignee)
// and dispatches them to the runner. One task at a time per agent (serial);
// extra ready tasks queue until the agent is idle. Intended to run on a
// server-side interval (boot plugin), skippable in tests via env.
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { tasks, taskRuns, taskStatuses, aiEmployees } from '../../db/schema'
import { dispatchTask } from './runner.service'
import { redisHub } from '../kernel/redis'
import { publishChange } from '../kernel/change-bus'

const inFlight = new Map<string, Promise<unknown>>() // employeeId -> run promise

export function activeRunCount(): number {
  return inFlight.size
}

/** reap runs stuck in 'running' past the hard timeout + grace: mark failed, bounce task to
 * ready (with the normal backoff ladder), so orphaned rows never pin a task in doing forever. */
export async function reapStaleRuns(): Promise<number> {
  try {
    return await reapStaleRunsInner()
  }
  catch {
    return 0 // best-effort sweep: a failed DB read just means try again next tick
  }
}

async function reapStaleRunsInner(): Promise<number> {
  const { getRunTimeoutMs } = await import('../settings/settings.service')
  const grace = 2 * 60_000
  const cutoff = new Date(Date.now() - (await getRunTimeoutMs()) - grace)
  const stale = await db.select().from(taskRuns).where(eq(taskRuns.status, 'running'))
  let reaped = 0
  for (const run of stale) {
    if (run.startedAt.getTime() > cutoff.getTime()) continue
    await db.update(taskRuns).set({ status: 'failed', exitCode: null, output: run.output ? `${run.output}\n[reaper] run timed out after ${Math.round((Date.now() - run.startedAt.getTime()) / 60_000)} min` : '[reaper] run timed out', finishedAt: new Date() }).where(eq(taskRuns.id, run.id))
    // only bounce the task if this was its latest run
    const latest = await db.select().from(taskRuns).where(eq(taskRuns.taskId, run.taskId))
    const newest = latest.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0]
    if (newest?.id === run.id) {
      // FK cascade: a present run implies its task row exists
      const current = (await db.select().from(tasks).where(eq(tasks.id, run.taskId)))[0]!
      const streak = current.failStreak + 1
      const waitMs = 15 * 60_000 // timeout = worst tier; something is wrong with the agent
      await db.update(tasks).set({ status: 'todo', failStreak: streak, dispatchAfter: new Date(Date.now() + waitMs), updatedAt: new Date() }).where(eq(tasks.id, run.taskId))
    }
    await publishChange('runs', 'update')
    await publishChange('tasks', 'update')
    reaped += 1
  }
  return reaped
}

/** find one eligible task: ready-category status, AI assignee, agent idle */
export async function findEligible(): Promise<{ taskId: string, employeeId: string } | null> {
  const statuses = await db.select().from(taskStatuses)
  const readyIds = statuses.filter(s => s.category === 'ready').map(s => s.id)
  if (readyIds.length === 0) return null
  const rows = await db.select().from(tasks)
  const aiRows = await db.select({ userId: aiEmployees.userId }).from(aiEmployees)
  const aiIds = new Set(aiRows.map(r => r.userId))
  const now = Date.now()
  const eligible = rows
    .filter(t => readyIds.includes(t.status) && t.assigneeId && aiIds.has(t.assigneeId))
    .filter(t => !inFlight.has(t.assigneeId!))
    // failure backoff: not claimable until dispatch_after passes (null = immediately)
    .filter(t => !t.dispatchAfter || t.dispatchAfter.getTime() <= now)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  const first = eligible[0]
  return first ? { taskId: first.id, employeeId: first.assigneeId! } : null
}

/** one scan step: claim + dispatch at most one task. Returns true if dispatched. */
export async function scanOnce(tandemUrl: string): Promise<boolean> {
  const hit = await findEligible()
  if (!hit) return false
  const hub = await redisHub()
  if (hub) {
    try {
      await hub.enqueue<DispatchJob>(DISPATCH_QUEUE, { taskId: hit.taskId, tandemUrl }, { attempts: 3 })
      return true
    }
    catch (e) {
      console.warn('[tandem] dispatch enqueue failed, retrying next scan:', (e as Error).message)
      return false // redis hiccup: try next scan
    }
  }
  try {
    const handle = await dispatchTask(hit.taskId, tandemUrl)
    inFlight.set(hit.employeeId, handle.finished.finally(() => inFlight.delete(hit.employeeId)))
    return true
  }
  catch {
    // dispatchTask validates its own preconditions; misses just mean "try next scan"
    return false
  }
}

/** boot hook: start the dispatcher unless opted out (tests set TANDEM_NO_DISPATCHER=1).
 * With REDIS_URL set, dispatch flows through a BullMQ per-agent queue (durable,
 * concurrency-1 per agent, exponential-backoff retries) instead of the interval
 * scanner; the scan loop still runs as a sweep for tasks queued while redis was down. */
export async function maybeStartDispatcher(): Promise<(() => void) | null> {
  if (process.env.TANDEM_NO_DISPATCHER) return null
  const url = process.env.TANDEM_PUBLIC_URL || 'http://localhost:3000'
  const hub = await redisHub()
  if (hub) {
    await hub.queue<DispatchJob>(DISPATCH_QUEUE, async (job) => {
      const run = await dispatchTask(job.taskId, job.tandemUrl)
      await run.finished // worker stays busy (concurrency 1) until the SSH run ends
    }, { concurrency: 1, attempts: 3 })
    console.log('[tandem] dispatch queue worker started (redis)')
  }
  const stop = startDispatcher(url)
  console.log(`[tandem] dispatcher started (${hub ? 'redis+interval' : 'interval'})`)
  return stop
}

export const DISPATCH_QUEUE = 'tandem-dispatch' // bullmq forbids ':' in queue names

export type DispatchJob = { taskId: string, tandemUrl: string }

/** start the interval; returns a stop function */
export function startDispatcher(tandemUrl: string, intervalMs = 5000): () => void {
  const timer = setInterval(() => {
    void scanOnce(tandemUrl) // scanOnce never rejects: its own catch turns errors into false
    void reapStaleRuns() // never rejects: its own catch turns errors into 0 reaped
  }, intervalMs)
  return () => clearInterval(timer)
}

/** runs lookup used by the router */
export { listRuns } from './runner.service'
export { taskRuns } from '../../db/schema'
