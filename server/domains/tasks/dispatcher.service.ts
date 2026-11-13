import { consola } from 'consola';
import { and, count, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';

import { ACTIVITY_KIND, CATEGORY, CHANGE_RESOURCE, CHANGE_ACTION, RUN_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';
// Dispatcher: scans for eligible tasks (ready-category status + AI assignee)
// and dispatches them to the runner. One task at a time per agent (serial);
// extra ready tasks queue until the agent is idle. Intended to run on a
// server-side interval (boot plugin), skippable in tests via env.
// SCAN BOUNDING LAW (#130): the tick never loads the whole tasks table — the
// eligible scan filters ready + AI-assignee in SQL and live-run counts come
// back in one GROUP BY; the reaper never reads transcripts.
import { nonNull } from '#shared/utils/non-null';

import { asDb, db, type DbExecutor } from '../../db/index';
import { aiEmployees, tasks, taskRuns, taskMessages, taskStatuses } from '../../db/schema';
import { publishChange } from '../kernel/change-bus';
import { env } from '../kernel/env';
import { redisQueue } from '../kernel/queue';
import { rearmParkedRounds } from './gating.service';
import { runRetentionLeg } from './retention.service';
import {
  DISPATCH_ATTEMPTS,
  dispatchQueueName,
  backoffFor,
  dispatchTask,
  executeRun,
  latestRunIdForTask,
  rearmUndeliveredCorrection,
  type DispatchJob,
} from './runner.service';

const log = consola.withTag('tandem');

/** REAPER LIVENESS (#147): a failed sweep is never silent — rate-limited to one
 * warn per 5 min so a persistent DB failure shows up in log shipping without
 * spamming the 5s tick. State exposed for tests. */
export const REAPER_WARN_INTERVAL_MS = 5 * 60_000;
export const reaperWarnState = { lastAt: 0 };
export const TICK_WARN_INTERVAL_MS = 5 * 60_000;
export const scanWarnState = { lastAt: 0 };

/** reap runs stuck in 'running' past the hard timeout + grace: mark failed, bounce task to
 * ready (with the normal backoff ladder), so orphaned rows never pin a task in doing forever. */
export async function reapStaleRuns() {
  try {
    return await reapStaleRunsInner();
  } catch (e) {
    const now = Date.now();
    if (now - reaperWarnState.lastAt >= REAPER_WARN_INTERVAL_MS) {
      reaperWarnState.lastAt = now;
      log.warn('stale-run reaper sweep failed (retrying next tick):', e instanceof Error ? e.message : e);
    }
    return 0; // best-effort sweep: a failed DB read just means try again next tick
  }
}

/** reaper sweep shape (#130): RUNNING rows already past the timeout cutoff —
 * id/started_at + the task-id join only, NEVER the transcript columns; the
 * status filter rides task_runs_status_idx. */
export function reapSweepScan(cutoff: Date) {
  return {
    columns: { id: true, startedAt: true },
    where: { status: { eq: RUN_STATUS.RUNNING }, startedAt: { lte: cutoff } },
    orderBy: { startedAt: 'asc' },
    with: { message: { columns: { taskId: true } } },
  } as const;
}

/** timed-out marker appended in the UPDATE's own SQL (#130) — the reaper marks
 * a stale run without re-reading (or shipping) its transcript */
export function reapOutputMarker(minutes: number) {
  return sql`CASE WHEN ${taskRuns.output} = '' THEN '[reaper] run timed out' ELSE ${taskRuns.output} || ${`\n[reaper] run timed out after ${minutes} min`} END`;
}

async function reapStaleRunsInner() {
  const { getRunTimeoutMs } = await import('../settings/settings.service');
  const grace = 2 * 60_000;
  const cutoff = new Date(Date.now() - (await getRunTimeoutMs()) - grace);
  const stale = await db.query.taskRuns.findMany(reapSweepScan(cutoff));
  let reaped = 0;
  for (const run of stale) {
    if (run.startedAt.getTime() > cutoff.getTime()) continue;
    const minutes = Math.round((Date.now() - run.startedAt.getTime()) / 60_000);
    const reapedRows = await db
      .update(taskRuns)
      .set({
        status: RUN_STATUS.FAILED,
        exitCode: null,
        output: reapOutputMarker(minutes),
        finishedAt: new Date(),
      })
      // RUNNING predicate: a run that just settled (finish() flipped it) must never
      // be overwritten by a reaper sweep that read the stale RUNNING list
      .where(and(eq(taskRuns.id, run.id), eq(taskRuns.status, RUN_STATUS.RUNNING)))
      .returning({ id: taskRuns.id });
    if (!reapedRows.length) continue; // settled concurrently — nothing to reap
    // only bounce the task if this was its latest run (shared findFirst, #163 —
    // was fetch-ALL runs of the task + JS sort: an unbounded scan)
    if ((await latestRunIdForTask(nonNull(run.message).taskId)) === run.id) {
      const taskId = nonNull(run.message).taskId;
      // FK cascade: a present run implies its task row exists
      const current = nonNull(
        (
          await db.query.tasks.findMany({
            columns: { failStreak: true, status: true },
            where: { id: { eq: taskId } },
            orderBy: { createdAt: 'asc' },
          })
        )[0],
      );
      // CATEGORY-GATE LAW (#336): classify by the status CATEGORY, never the seeded
      // uuid — a custom in-review status parks exactly like the seeded one, and only
      // a WORKING-category task rides the work ladder (a terminal/paused/waiting row
      // is never resurrected by a late reap).
      const categoryRows = await db.query.taskStatuses.findMany({
        columns: { id: true, category: true },
        where: { id: { eq: current.status } },
      });
      const category = categoryRows.find((r) => r.id === current.status)?.category;
      if (category === CATEGORY.IN_REVIEW || category === CATEGORY.PAUSED) {
        // a review turn that timed out never rides the work ladder (#199): the todo-flip
        // yanks an in-review task out of its open round (rows stay PENDING, nothing
        // re-fires them). Park on the owner; unblock re-dispatches the reviewer.
        // GATING AUTO-BLOCK (#419): a paused task is offered to parkRound too — it
        // refuses a park already standing and an owner-moved block, and parks a
        // child-derived block from an in-review origin (the failed turn's only recovery).
        const { parkRound } = await import('./review.service');
        // REARMABLE (#211): a timed-out review turn is infra-class (env/runner outage).
        // UNDELIVERED RETRY (#420): a reaped CORRECTION run delivered nothing — re-arm
        // the parked intent so the ladder's restore re-fire carries the block.
        await rearmUndeliveredCorrection(taskId, run.id);
        await parkRound(taskId, `review turn timed out — reaped after ${minutes} min`, { rearmable: true });
      } else if (category === CATEGORY.WORKING) {
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
          // atomic re-check (#162 pattern): a settle/status change between read and
          // write wins — the bounce only lands on the status this sweep READ
          .where(and(eq(tasks.id, taskId), eq(tasks.status, current.status)));
      }
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

/** fixed bound on the sweep read (#225): idle relics bounce at ≤ this per tick
 * and the remainder waits for the next 5s tick — the sweep never fans out over
 * a stuck-relic backlog. */
export const LIVENESS_SWEEP_MARGIN = 25;

/** sweep read shape (#225): ONE statement per tick — the newest run per
 * working candidate arrives via a LATERAL join (task_runs ⋈ task_messages via
 * message_id — runs carry no task_id, newest started_at first), the
 * no-live-run and idle-past-grace predicates ride the SQL WHERE and the read
 * is LIMIT-bounded; executor-injected for query-shape tests. */
export function idleSweepScan(ex: DbExecutor, cutoff: Date, limit: number) {
  return asDb(ex)
    .select({
      id: tasks.id,
      status: tasks.status,
      updatedAt: tasks.updatedAt,
      newestStatus: sql<string | null>`newest.status`,
      newestFinishedAt: sql<Date | null>`newest.finished_at`,
    })
    .from(tasks)
    .innerJoin(taskStatuses, eq(taskStatuses.id, tasks.status))
    .innerJoin(aiEmployees, eq(aiEmployees.userId, tasks.assigneeId))
    .leftJoinLateral(
      asDb(ex)
        .select({ status: taskRuns.status, finished_at: taskRuns.finishedAt })
        .from(taskRuns)
        .innerJoin(taskMessages, eq(taskMessages.id, taskRuns.messageId))
        .where(eq(taskMessages.taskId, tasks.id))
        .orderBy(desc(taskRuns.startedAt))
        .limit(1)
        .as('newest'),
      sql`true`,
    )
    .where(
      and(
        eq(taskStatuses.category, 'working'),
        or(isNull(sql`newest.status`), ne(sql`newest.status`, RUN_STATUS.RUNNING)),
        sql`coalesce(newest.finished_at, ${tasks.updatedAt}) < ${cutoff}`,
      ),
    )
    .limit(limit);
}

/** the bounce write's predicate (#427): id AND the status this scan READ. The status
 *  term is load-bearing — without it a gating auto-block landing inside the scan window is
 *  yanked out of its block (the row would leave carrying pre_block_status and its next park
 *  would inherit the home). Exported so the CAS terms are pinned by shape, like the scans. */
export function livenessBounceWhere(id: string, status: string) {
  return and(eq(tasks.id, id), eq(tasks.status, status));
}

/** the bounce write's field set (#427): the status landing AND the machine-memory
 * exhaustion it must carry in the same statement. Pure so the pin can assert every field
 * — a field silently dropped from an inline literal is the exact regression class. */
export function livenessBouncePatch(): {
  status: string;
  preBlockStatus: null;
  parkFromStatus: null;
  parkRearmAttempts: 0;
  parkRearmAfter: null;
  dispatchAfter: null;
  updatedAt: Date;
} {
  return {
    status: STATUS.todo,
    preBlockStatus: null,
    parkFromStatus: null,
    parkRearmAttempts: 0,
    parkRearmAfter: null,
    dispatchAfter: null,
    updatedAt: new Date(),
  };
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
  // bounded ONE-statement read (#225): newest run + idle predicate + limit all
  // in SQL — the tick never issues a per-row newest-run query
  const rows = await idleSweepScan(db, new Date(now - LIVENESS_GRACE_MS), LIVENESS_SWEEP_MARGIN);
  let bounced = 0;
  for (const row of rows) {
    // parity guard: the SQL WHERE and the pure decision agree by construction;
    // routing through livenessBounce keeps the bounce decision single-sourced
    const newestFinishedAt = row.newestFinishedAt ? new Date(row.newestFinishedAt) : null;
    if (
      !livenessBounce(
        {
          category: 'working',
          isAiAssignee: true,
          newestRunStatus: row.newestStatus ?? null,
          newestRunSettledAt: newestFinishedAt,
          updatedAt: row.updatedAt,
        },
        now,
      )
    )
      continue;
    // EGRESS EXHAUSTION (#427): a bounce is a legal egress from a working status, and the
    // scan's window admits a gating auto-block landing between the read and this write
    // (a child spawn re-blocks its parent while the sweep holds the row). Without the CAS
    // the bounce would write to-do OVER that block and leave pre_block_status behind (the
    // row leaves the block still carrying its restore home, and the parent's next park
    // inherits it) — so the write CASes on the status this scan READ and exhausts both
    // origins + the ledger in the same statement (the reaper's #162 pattern).
    const bouncedRows = await db
      .update(tasks)
      .set(livenessBouncePatch())
      .where(livenessBounceWhere(row.id, row.status))
      .returning({ id: tasks.id });
    // a LOST CAS writes nothing (a block/settle landed in the scan window) — the thread
    // note and the counter must not claim a bounce that never happened
    if (bouncedRows.length === 0) continue;
    const { logActivity } = await import('./review.service');
    await logActivity(
      row.id,
      ACTIVITY_KIND.STATUS,
      null,
      '[liveness] idle in a working status with no live run — returned to to-do',
      { livenessBounce: true, idleSince: (newestFinishedAt ?? row.updatedAt).toISOString() },
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

/** fixed margin on the scan LIMIT (#176): covers rows claimed between the cap
 * read and the scan landing — the bounded read can never miss a claimable task
 * that the next 5s tick would not pick up anyway. */
const DISPATCH_SCAN_MARGIN = 16;

/** eligible-task scan shape (#130, #176): ready-category + AI-assignee + the
 * elapsed-backoff predicate all ride the SQL WHERE (created_at order preserved)
 * and the read is LIMIT-bounded to cap×agents+margin — the tick never re-reads
 * the whole ready∩AI backlog while agents sit at cap. */
export function eligibleTaskScan(readyIds: string[], aiIds: string[], backoffCutoff: Date, limit: number) {
  return {
    columns: { id: true, status: true, assigneeId: true, dispatchAfter: true, createdAt: true } as const,
    where: {
      status: { in: readyIds },
      assigneeId: { in: aiIds },
      OR: [{ dispatchAfter: { isNull: true as const } }, { dispatchAfter: { lte: backoffCutoff } }],
    },
    orderBy: { createdAt: 'asc' as const },
    limit,
  };
}

/** one GROUP BY query for every agent's live-run count (#130) — never a
 * serialized COUNT per candidate; executor-injected for query-shape tests */
export function liveRunsByAgent(ex: DbExecutor, aiIds: string[]) {
  return asDb(ex)
    .select({ employeeId: taskRuns.employeeId, live: count() })
    .from(taskRuns)
    .where(and(eq(taskRuns.status, RUN_STATUS.RUNNING), inArray(taskRuns.employeeId, aiIds)))
    .groupBy(taskRuns.employeeId);
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
  const aiRows = await db.query.aiEmployees.findMany({ columns: { userId: true }, orderBy: { userId: 'asc' } });
  const aiIds = aiRows.map((r) => r.userId);
  if (aiIds.length === 0) return null;

  // SCAN BOUNDING LAW (#130, #176): ready ∩ AI ∩ elapsed-backoff filtered in SQL,
  // read LIMIT-bounded to cap×agents+margin — cap read BEFORE the scan
  const cap = await tasksPerAgentCap();
  const limit = cap * aiIds.length + DISPATCH_SCAN_MARGIN;
  const eligible = await db.query.tasks.findMany(eligibleTaskScan(readyIds, aiIds, new Date(), limit));
  if (eligible.length === 0) return null;
  const liveByAgent = new Map((await liveRunsByAgent(db, aiIds)).map((r) => [r.employeeId, r.live]));
  for (const t of eligible) {
    const employeeId = nonNull(t.assigneeId);
    if (atCap(liveByAgent.get(employeeId) ?? 0, cap)) continue;
    return { taskId: t.id, employeeId };
  }
  return null;
}

/** one scan step: claim + dispatch at most one task. Returns true if dispatched.
 * The run row (frozen brief) is created HERE and the job carries its id — retries
 * replay the run, they never rebuild it (run-level retry law, 2026-10-28).
 * TICK-ISOLATION LAW (#172): scanOnce never rejects — findEligible's DB reads are
 * inside this catch too; the startDispatcher call sites are bare `void scanOnce()`
 * and on the bun runtime an unhandled rejection terminates the whole process. */
export async function scanOnce(tandemUrl: string) {
  try {
    return await scanOnceInner(tandemUrl);
  } catch (e) {
    const now = Date.now();
    if (now - scanWarnState.lastAt >= TICK_WARN_INTERVAL_MS) {
      scanWarnState.lastAt = now;
      log.warn('dispatch scan failed (retrying next tick):', e instanceof Error ? e.message : e);
    }
    return false; // failed scan just means try again next tick
  }
}

/** WORKER-RESYNC RETRY (#291 F10): a swallowed resync failure — the per-hit
 * detached sync's silent catch, the settings/roster-change resync's logged catch —
 * left the roster stale forever whenever the scan never hits (a review-only queue
 * has no ready task to fire the per-hit resync, so the heartbeat + redis-ok stay
 * green while every dispatch wedges). A failed sync re-arms and re-fires on every
 * tick regardless of scan hits until one lands (coalescing keeps it single-flight). */
let needsWorkerResync = false;

/** never throws — the tick-isolation contract holds even while retrying (#172) */
async function retryPendingWorkerResync(): Promise<void> {
  if (!needsWorkerResync) return;
  const hub = await redisQueue().catch(() => null);
  if (!hub) return; // no redis: nothing to sync into — stay armed for the next tick
  const synced = await syncDispatchWorkers(hub)
    .then(() => true)
    .catch(() => false);
  if (synced) needsWorkerResync = false;
}

async function scanOnceInner(tandemUrl: string) {
  await retryPendingWorkerResync(); // every tick, hit or not (#291 F10)
  const hit = await findEligible();
  if (!hit) return false;
  try {
    const hub = await redisQueue();
    /* v8 ignore next -- lazy resync; the catch arrow only fires on a redis failure */
    void syncDispatchWorkers(hub)
      .then(() => {
        needsWorkerResync = false;
      })
      .catch(() => {
        needsWorkerResync = true; // arm the per-tick retry — never silent forever (#291 F10)
      }); // workers may not exist yet (first dispatch after boot)
    // a lost claim (#162) is a stale duplicate, not a dispatch — the scan keeps looking
    const dispatched = await dispatchTask(hit.taskId, tandemUrl);
    return dispatched.runId !== null;
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

/** WORKER-SYNC COALESCING (#290): syncDispatchWorkers is check-then-act across an
 * await and runs from four entry points (per-tick detached resync, settings update,
 * employee create/update, boot) — overlapping calls both saw "no worker for agent
 * X" and both created one, doubling the execution concurrency and leaving a
 * duplicate no later sync ever removes. One execution in flight per process;
 * concurrent callers await the SAME promise; the roster re-check stays
 * authoritative once it lands. A caller whose intent POST-DATES the in-flight read
 * (settings cap / employee roster changed just before its call) passes
 * resyncAfter: true — the in-flight sync may have read pre-change state, so the
 * caller's promise chains ONE follow-up execution after it lands (the new cap or
 * roster applies without waiting for the next trigger; simultaneous follow-ups
 * coalesce onto each other like any other sync). */
let syncInFlight: Promise<void> | null = null;

export function syncDispatchWorkers(
  hub: NonNullable<Awaited<ReturnType<typeof redisQueue>>>,
  opts: { resyncAfter?: boolean } = {},
): Promise<void> {
  if (syncInFlight) {
    if (opts.resyncAfter) return syncInFlight.then(() => syncDispatchWorkers(hub));
    return syncInFlight;
  }
  syncInFlight = syncDispatchWorkersInner(hub).finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

/** a stale dispatch call (task already running/done/waiting) must quietly no-op: no
 * re-run, no retry storm, no status flip. Returns whether a run actually fired —
 * the note verb reports it (a silent skip must not claim 'agent dispatched', r5). */
export async function dispatchIfEligible(taskId: string, tandemUrl: string): Promise<boolean> {
  const statuses = await db.query.taskStatuses.findMany({
    columns: { id: true, category: true },
    orderBy: { position: 'asc' },
  });
  const readyIds = new Set(statuses.filter((s) => s.category === 'ready').map((s) => s.id));
  const row = await db.query.tasks.findFirst({
    columns: { status: true, dispatchAfter: true, assigneeId: true },
    where: { id: { eq: taskId } },
  });
  if (!row || !readyIds.has(row.status)) return false; // stale duplicate: skip
  // backoff law: a dispatch call must not bypass the failure backoff the runner set —
  // the scan loop respects dispatch_after; the direct path has to as well
  if (row.dispatchAfter && row.dispatchAfter.getTime() > Date.now()) return false;
  // CAP LAW: the direct path obeys the same per-agent cap as the scan — a busy agent
  // gains no second claim because a human typed at the right moment. The scan picks
  // the task up as soon as a slot frees.
  if (row.assigneeId && atCap(await liveRunCountFor(row.assigneeId), await tasksPerAgentCap())) return false;
  // returns after enqueue — the per-agent worker executes the run (composer law:
  // submitting dispatches the run; the RPC never rides the turn)
  const { runId } = await dispatchTask(taskId, tandemUrl);
  // a null run is a stale duplicate (the scan won the claim, the plan's assignee left
  // the row, or the employee vanished) — the note must report thread-only, never
  // 'agent dispatched' (#406; the pre-#406 lost-claim case had the same lie)
  return runId !== null;
}

/** the retry-delay ladder for run-level transport retries: same steps as the
 * task-level backoff, keyed by the FAILED attempt number, with the quota jump
 * reading the run's appended error output. */
async function dispatchBackoffDelay(failedAttempt: number, runId: string): Promise<number> {
  const row = await db.query.taskRuns.findFirst({ columns: { output: true }, where: { id: { eq: runId } } });
  return backoffFor(failedAttempt, row?.output ?? '');
}

async function syncDispatchWorkersInner(hub: NonNullable<Awaited<ReturnType<typeof redisQueue>>>) {
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
          verdictCorrection: job.verdictCorrection,
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
    // resyncAfter: the settings write post-dates any in-flight sync's cap read —
    // the follow-up execution guarantees the NEW cap applies now, not next trigger
    await syncDispatchWorkers(hub, { resyncAfter: true });
  } catch (e) {
    needsWorkerResync = true; // arm the per-tick retry (#291 F10) — a swallowed hire-time resync must never strand a workerless queue
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

/** fixed boot-retry cadence (#147): machine interval, 24/7 — no wall-clock logic. */
export const DISPATCHER_BOOT_RETRY_MS = 30_000;

/** REAPER LIVENESS boot path (#147): attempt `start` (maybeStartDispatcher) once
 * immediately, then retry on a fixed interval until it succeeds. A redis blip at
 * restart must not leave the server serving with no dispatcher and no reaper.
 * A null return means the dispatcher is intentionally disabled
 * (TANDEM_NO_DISPATCHER) — retries stop, no error. Returns a stop fn that ends
 * retries and stops a dispatcher the loop started. */
export function ensureDispatcherRunning(opts: {
  start: () => Promise<(() => void) | null>;
  intervalMs?: number;
}): () => void {
  const retryMs = opts.intervalMs ?? DISPATCHER_BOOT_RETRY_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let startedStop: (() => void) | null = null;
  const attempt = () => {
    if (startedStop) return;
    let p: Promise<(() => void) | null>;
    try {
      p = opts.start();
    } catch (e) {
      log.error(dispatcherBootFailLine(e, retryMs));
      return;
    }
    p.then((stop) => {
      if (stop === null) {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        return;
      }
      startedStop = stop;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      log.success('dispatcher started (after boot retry)');
    }).catch((e) => {
      log.error(dispatcherBootFailLine(e, retryMs));
    });
  };
  attempt();
  timer = setInterval(attempt, retryMs);
  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    startedStop?.();
    startedStop = null;
  };
}

function dispatcherBootFailLine(e: unknown, retryMs: number) {
  return `dispatcher failed to start (${e instanceof Error ? e.message : String(e)}) — retrying every ${retryMs / 1000}s until the queue is reachable`;
}

/** DISPATCHER HEARTBEAT (#172): each tick stamps settings `dispatcher_last_tick`
 * (epoch ms, at most one write per 30s, best-effort) so the prod watchdog can
 * alert on a dead dispatcher; a missing key = pre-heartbeat image and stays silent. */
export const DISPATCHER_HEARTBEAT_KEY = 'dispatcher_last_tick';
const HEARTBEAT_WRITE_INTERVAL_MS = 30_000;
/** throttle state exposed for tests (same pattern as reaperWarnState) */
export const heartbeatState = { lastAt: 0 };
export async function touchDispatcherHeartbeat() {
  try {
    if (Date.now() - heartbeatState.lastAt < HEARTBEAT_WRITE_INTERVAL_MS) return;
    heartbeatState.lastAt = Date.now();
    const { setSetting } = await import('../settings/settings.service');
    await setSetting(DISPATCHER_HEARTBEAT_KEY, String(Date.now()));
  } catch {
    // heartbeat is best-effort: observability must never crash the tick
  }
}

/** REDIS-OK STAMP (#238): each tick pings the queue domain and stamps settings
 * `dispatcher_redis_ok` (epoch ms, same 30s throttle + best-effort catch as the
 * heartbeat) ONLY on success — during an outage the stamp goes stale while the
 * heartbeat keeps writing, and the prod probe alerts the brick signature
 * (heartbeat fresh + redis stamp stale) instead of reporting healthy. */
export const REDIS_OK_KEY = 'dispatcher_redis_ok';
/** throttle state exposed for tests (same pattern as heartbeatState) */
export const redisOkState = { lastAt: 0 };
export async function touchDispatcherRedisOk() {
  try {
    if (Date.now() - redisOkState.lastAt < HEARTBEAT_WRITE_INTERVAL_MS) return;
    redisOkState.lastAt = Date.now();
    const { redisQueue } = await import('../kernel/queue');
    const ok = await (await redisQueue()).ping();
    if (!ok) return; // stale stamp = the detection signal; never write on failure
    const { setSetting } = await import('../settings/settings.service');
    await setSetting(REDIS_OK_KEY, String(Date.now()));
  } catch {
    // redis down may make redisQueue()/ping() throw — same best-effort law
  }
}

/** STALLED-REVIEW SWEEP wiring (#397): a committed round whose reviewer turn never
 *  dispatched (crash window between the round-open transaction and the turn) is
 *  re-fired from the tick. The import stays dynamic so the tick pays nothing on the
 *  happy path (review.service is already reachable statically via gating.service);
 *  never rejects, like every other tick arm. */
async function sweepStalledReviewsTick() {
  try {
    const { sweepStalledReviewTurns, sweepLostReviewSettles } = await import('./review.service');
    // SETTLE-REPLAY SWEEP (#402) RUNS FIRST: a crashed settle must be replayed before the
    // #397 sweep mints the NEXT reviewer's turn — the round is sequential, and a mint
    // here would mask the replay (that turn's verdict opens a later run for the crashed
    // reviewer). The #397 scan also excludes the lost-settle shape, so the order is
    // belt-and-braces. Same never-reject contract (each sweep owns its try/catch).
    await sweepLostReviewSettles();
    await sweepStalledReviewTurns();
  } catch (e) {
    log.warn('stalled-review tick failed:', e instanceof Error ? e.message : e);
  }
}

/** start the interval; returns a stop function */
export function startDispatcher(tandemUrl: string, intervalMs = 5000): () => void {
  const timer = setInterval(() => {
    void scanOnce(tandemUrl); // TICK-ISOLATION (#172): never rejects — its own catch turns errors into false
    void reapStaleRuns(); // never rejects: its own catch turns errors into 0 reaped
    void sweepIdleWorking(); // never rejects: its own catch turns errors into 0 bounced
    void rearmParkedRounds(); // never rejects: its own catch turns errors into 0 rearmed
    void sweepStalledReviewsTick(); // never rejects: its own catch turns errors into 0 re-fired (#397)
    void touchDispatcherHeartbeat(); // best-effort watchdog stamp (its own catch)
    void touchDispatcherRedisOk(); // best-effort watchdog stamp (#238, its own catch)
    void runRetentionLeg(); // daily retention leg (#266) — never rejects (its own catch)
  }, intervalMs);
  return () => clearInterval(timer);
}

/** runs lookup used by the router */
export { listRuns } from './runner.service';
export { taskRuns } from '../../db/schema';
