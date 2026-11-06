// RETENTION LAW (#266): the dispatcher tick carries a daily retention leg that
// bounds unbounded storage without deleting audit rows. Three legs, each
// LIMIT-bounded, each pushing its age/category predicate into the SQL WHERE
// (never a fetch-all):
//   1. settled runs of TERMINAL-category tasks past the horizon get their
//      transcript blanked in place (output='', prompt=NULL) — the row and its
//      audit identity stay; hasOutput/hasPrompt collapse to false and
//      tasks.runTranscript honestly returns the blank body;
//   2. non-PENDING obligations resolved past the horizon are deleted
//      (PENDING rows are still actionable and are NEVER touched);
//   3. expired auth sessions are deleted (live sessions are NEVER touched).
// Throttle: settings stamp `retention_last_run` (epoch ms) — one run per 24h,
// stamped ONLY on a full pass; a failed leg leaves the stamp untouched (the
// next tick retries) and warns rate-limited like the reaper (#147).
// Fault isolation (#172): this leg never rejects — its own catch turns errors
// into a quiet no-op so a retention fault can never crash the tick.
import { consola } from 'consola';
import { and, asc, eq, inArray, lt, ne } from 'drizzle-orm';

import { asDb, db, type DbExecutor } from '../../db/index';
import { taskMessages, taskObligations, taskRuns, tasks, taskStatuses } from '../../db/schema';
import { session } from '../../db/schema.auth';

/** transcripts older than this horizon (settled + terminal task) get blanked */
export const RETENTION_HORIZON_MS = 30 * 24 * 60 * 60_000;
/** per-leg batch cap — a day-tick drains the oldest batch; relics follow tomorrow */
export const RETENTION_BATCH = 500;
export const RETENTION_STAMP_KEY = 'retention_last_run';
const RETENTION_INTERVAL_MS = 24 * 60 * 60_000;
/** rate-limited warn window (same as the reaper, #147) */
const RETENTION_WARN_INTERVAL_MS = 5 * 60_000;

/** throttle state exposed for tests (same pattern as heartbeatState) */
export const retentionState = { lastAt: 0, lastWarnAt: 0 };

/** terminal-category status ids — the category join (seeded categories are
 * lowercase 'done'|'cancelled'; VERB-GATE CATEGORY LAW: never status-id literals) */
export function terminalCategoryScan(ex: DbExecutor = db) {
  return asDb(ex)
    .select({ id: taskStatuses.id })
    .from(taskStatuses)
    .where(inArray(taskStatuses.category, ['done', 'cancelled']));
}

/** leg 1 scan: settled runs of terminal-category tasks past the horizon,
 * oldest-finished first — the transcript-blanking target set, LIMIT-bounded.
 * The task is reached via the run's message (task_runs has NO task_id — user
 * design 2026-10-26); the category predicate rides the SQL WHERE. */
export function blankableTranscriptsScan(cutoff: Date, ex: DbExecutor = db) {
  return asDb(ex)
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .innerJoin(taskMessages, eq(taskRuns.messageId, taskMessages.id))
    .innerJoin(tasks, eq(taskMessages.taskId, tasks.id))
    .where(
      and(
        ne(taskRuns.status, 'RUNNING'),
        lt(taskRuns.finishedAt, cutoff),
        inArray(tasks.status, terminalCategoryScan(ex)),
      ),
    )
    .orderBy(asc(taskRuns.finishedAt))
    .limit(RETENTION_BATCH);
}

/** leg 2 scan: non-PENDING obligations resolved past the horizon,
 * oldest-resolved first, LIMIT-bounded. PENDING rows never match. */
export function resolvedObligationsScan(cutoff: Date, ex: DbExecutor = db) {
  return asDb(ex)
    .select({ id: taskObligations.id })
    .from(taskObligations)
    .where(and(ne(taskObligations.status, 'PENDING'), lt(taskObligations.resolvedAt, cutoff)))
    .orderBy(asc(taskObligations.resolvedAt))
    .limit(RETENTION_BATCH);
}

/** leg 3 scan: expired auth sessions, LIMIT-bounded */
export function expiredSessionsScan(now: Date, ex: DbExecutor = db) {
  return asDb(ex)
    .select({ id: session.id })
    .from(session)
    .where(lt(session.expiresAt, now))
    .orderBy(asc(session.expiresAt))
    .limit(RETENTION_BATCH);
}

export type RetentionResult = { blanked: number; obligations: number; sessions: number };

/** leg 1: blank the transcripts of the scanned runs (rows KEPT for audit) */
export async function blankRunTranscripts(cutoff: Date, ex: DbExecutor = db): Promise<number> {
  const rows = await asDb(ex)
    .update(taskRuns)
    .set({ output: '', prompt: null })
    .where(inArray(taskRuns.id, blankableTranscriptsScan(cutoff, ex)))
    .returning({ id: taskRuns.id });
  return rows.length;
}

/** leg 2: delete the scanned resolved obligations */
export async function deleteResolvedObligations(cutoff: Date, ex: DbExecutor = db): Promise<number> {
  const rows = await asDb(ex)
    .delete(taskObligations)
    .where(inArray(taskObligations.id, resolvedObligationsScan(cutoff, ex)))
    .returning({ id: taskObligations.id });
  return rows.length;
}

/** leg 3: delete the scanned expired sessions */
export async function deleteExpiredSessions(now: Date, ex: DbExecutor = db): Promise<number> {
  const rows = await asDb(ex)
    .delete(session)
    .where(inArray(session.id, expiredSessionsScan(now, ex)))
    .returning({ id: session.id });
  return rows.length;
}

/** the daily retention leg — runs the three legs then stamps, or warns
 * rate-limited and leaves the stamp (retry next tick). Never rejects (#172). */
export async function runRetentionLeg(ex: DbExecutor = db): Promise<RetentionResult | null> {
  try {
    if (Date.now() - retentionState.lastAt < RETENTION_INTERVAL_MS) return null;
    const { getSetting, setSetting } = await import('../settings/settings.service');
    const stamp = await getSetting(RETENTION_STAMP_KEY);
    const stampMs = stamp ? Number(stamp) : 0;
    if (Number.isFinite(stampMs) && Date.now() - stampMs < RETENTION_INTERVAL_MS) {
      retentionState.lastAt = Date.now(); // in-memory cache of the persisted stamp
      return null;
    }
    const cutoff = new Date(Date.now() - RETENTION_HORIZON_MS);
    const result: RetentionResult = {
      blanked: await blankRunTranscripts(cutoff, ex),
      obligations: await deleteResolvedObligations(cutoff, ex),
      sessions: await deleteExpiredSessions(new Date(), ex),
    };
    await setSetting(RETENTION_STAMP_KEY, String(Date.now()), ex);
    retentionState.lastAt = Date.now();
    return result;
  } catch (e) {
    const now = Date.now();
    if (now - retentionState.lastWarnAt >= RETENTION_WARN_INTERVAL_MS) {
      retentionState.lastWarnAt = now;
      consola
        .withTag('dispatcher')
        .warn('retention leg failed (retrying next tick):', e instanceof Error ? e.message : e);
    }
    return null;
  }
}
