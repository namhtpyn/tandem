import { consola } from 'consola';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';

import { PROPOSAL_KIND } from '#shared/enums';
import type { RoutingProposal } from '#shared/run-verdict';
// Agent runner: dispatch a task to its AI assignee over SSH as ONE ACP
// prompt turn (Agent Client Protocol v1 over stdio), stream session updates
// back, persist the FULL output on the run row (appended in chunks, never
// tailed). Secrets (SSH identity, agent LLM key) are decrypted in memory only
// and NEVER placed on argv — they ride
// a stdin env blob inside the remote shell (byte-count framed ahead of the
// JSON-RPC stream), per the M5 law. One ACP session per task: first dispatch
// creates it, later dispatches resume it (the agent keeps its own task
// memory across runs); the agent PROCESS dies after every turn.
//
// TANDEM_FAKE_RUNNER=1 short-circuits SSH with a synthetic emitter so CI and
// local e2e can exercise the full dispatch→stream→finish loop with no host.
import { nonNull } from '#shared/utils/non-null';

import { asDb, db, type DbExecutor } from '../../db/index';
import { environments, tasks, taskRuns, taskAttachments, taskMessages } from '../../db/schema';
import { env } from '../kernel/env';
import { publishChange } from '../kernel/kernel';
import { redisQueue } from '../kernel/queue';
import { decryptSecret } from '../vault/secret/secret-crypto.service';
import { transcriptSnapshotColumns } from './run-transcript';

// FULL output is kept on the run row (user law 2026-10-15: "the task output must
// show full output") — no line tailing; the DB text column carries whatever the
// agent produced.

// stream-flush cadence; overridable so tests can exercise the flush path quickly
function flushMs() {
  return Number(env.TANDEM_RUN_FLUSH_MS ?? 500);
}

// hard cap on one run; a hung agent (frozen process, TCP never drops) becomes a failure
import { getRunTimeoutMs } from '../settings/settings.service';

// failure backoff ladder: consecutive failures -> wait before the next claim
const BACKOFF_STEPS_MS = [60_000, 5 * 60_000, 15 * 60_000]; // 1min, 5min, 15min cap

/** quota/limit signatures in run output jump straight to the longest backoff tier */
const QUOTA_PATTERN =
  /(402|429|insufficient[ _]?(quota|credit)|rate.?limit|out of (usage|credits|quota)|exceeded your|billing)/i;

export function backoffFor(failStreak: number, output: string) {
  const quota = QUOTA_PATTERN.test(output);
  if (quota) return nonNull(BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1]);
  return nonNull(BACKOFF_STEPS_MS[Math.min(Math.max(failStreak - 1, 0), BACKOFF_STEPS_MS.length - 1)]);
}

export type RunHandle = {
  runId: string;
  finished: Promise<{ status: FinishedStatus; exitCode: number | null }>;
};

/** live ACP turns by runId — a note sent while a run executes steers it (a second
 * session/prompt on the open stream); gone the moment the turn settles.
 * STEER-HOOK LIFECYCLE (#161, SPEC): each value closes over the run's ACP client
 * context (connection + bridged streams) — an entry surviving its run pins that
 * context forever. executeRun's finally is the single delete point every settle
 * path passes exactly once (the only other delete is a FAILED steer, :96). */
const liveSteers = new Map<string, (text: string) => Promise<boolean>>();

/** test/probe visibility (#161): runIds currently holding a live steer hook —
 * must be empty whenever no run is mid-turn (a settled run retains nothing) */
export function liveSteerRunIds(): string[] {
  return [...liveSteers.keys()];
}

/** pure decision: the newest candidate run that is still RUNNING (candidates newest-first) */
export function pickLiveRun(candidates: Array<{ id: string; status: string }>): string | null {
  return candidates.find((r) => r.status === RUN_STATUS.RUNNING)?.id ?? null;
}

/** the runs lookup config — exported so the query shape is pinned by test:
 *  runs joined to THEIR message's task, newest run first (never newest-message) */
export function liveRunsQuery(taskId: string) {
  return {
    columns: { id: true, status: true },
    where: { message: { taskId: { eq: taskId } } },
    orderBy: { startedAt: 'desc', id: 'desc' },
    limit: 10,
  } as const;
}

/** the "newest run of a task" findFirst shape — pinned by test (#163: the check
 * was triplicated; the reaper's copy fetched ALL runs of the task and JS-sorted,
 * an unbounded scan; this is the one shared query: newest started_at, LIMIT 1) */
export function latestRunOfTaskScan(taskId: string) {
  return {
    columns: { id: true },
    where: { message: { taskId: { eq: taskId } } },
    orderBy: { startedAt: 'desc' },
  } as const;
}

/** id of the newest run of a task (startedAt desc) — the single shared helper for
 * every is-this-the-latest-run check (run bounce, superseded-intent, reaper bounce) */
export async function latestRunIdForTask(taskId: string): Promise<string | null> {
  const latest = await db.query.taskRuns.findFirst(latestRunOfTaskScan(taskId));
  return latest?.id ?? null;
}

/** the task's live run id, if any — status/assignee edits are locked while it runs.
 *  Queries the RUNS table (runs → its thread message → task), never "newest thread
 *  message": notes dual-write to the thread, so the newest message is usually a
 *  bare note whose runless row answered "stopped" and poisoned both the steer
 *  lookup and the run-lock guard (composer law dead since 2026-10-26). */
export async function runningRunIdForTask(taskId: string): Promise<string | null> {
  const runs = await db.query.taskRuns.findMany(liveRunsQuery(taskId));
  return pickLiveRun(runs);
}

/** steer the task's live run. 'stopped' = no live run (safe to dispatch);
 *  'refused' = a run is live but this turn can't take input (fake runner) */
export async function steerRun(taskId: string, text: string): Promise<'steered' | 'stopped' | 'refused'> {
  const runId = await runningRunIdForTask(taskId);
  if (!runId) return 'stopped';
  const steer = liveSteers.get(runId);
  if (!steer) return 'refused';
  const ok = await steer(text).catch(() => false);
  if (!ok) liveSteers.delete(runId);
  return ok ? 'steered' : 'refused';
}

async function logRun(
  taskId: string,
  runId: string,
  body: string,
  meta: Record<string, unknown> = {},
  opts: { publishActivity?: boolean } = {},
) {
  // run bookkeeping lives on the run row + the run card's status pill — no
  // activity row since task_activity retired (2026-10-30). The publishes keep
  // the task surface (thread/review caches) current.
  await publishChange(CHANGE_RESOURCE.RUNS, CHANGE_ACTION.UPDATE);
  // dispatch defers this ping until the run's thread turn exists (see dispatchTask):
  // an activity publish before createRunMessage lets the thread cache rebuild
  // without the run bubble and then keep that stale snapshot
  if (opts.publishActivity !== false) await publishChange(CHANGE_RESOURCE.TASK_ACTIVITY, CHANGE_ACTION.CREATE);
}

/** PROMPT-INLINE IMAGES (SPEC 2026-10-31): read the split's selected input images
 * for the turn's image content blocks; an unreadable file logs and leaves the
 * agent its staged copy — never fails the dispatch. */
async function readInlineImages(
  taskId: string,
  files: Array<{ id: string; filename: string; mime: string; size: number }> | undefined,
  onLine: (line: string) => void,
): Promise<Array<{ data: string; mimeType: string }>> {
  const out: Array<{ data: string; mimeType: string }> = [];
  for (const f of promptImageSplit(files ?? []).inline) {
    try {
      const bytes = await readAttachmentBytes(taskId, f.id);
      out.push({ data: bytes.toString('base64'), mimeType: f.mime });
    } catch {
      onLine(`[dispatch] inline image ${f.filename} unavailable — the agent should use the staged copy`);
    }
  }
  return out;
}

/** persist the first-contact host key fingerprint (TOFU store, SPEC: Environments) */
export async function saveHostKeyFingerprint(envId: string, fingerprint: string) {
  await db.update(environments).set({ hostKeyFingerprint: fingerprint }).where(eq(environments.id, envId));
}

/** sshPlan + host-key TOFU trust state (host-key law, SPEC: Environments) —
 * every transport built from it verifies through this one store */
function sshPlanOf(plan: {
  env: { id: string; host: string; port: string; username: string; hostKeyFingerprint: string | null };
  sshKey?: string;
  sshPassword?: string;
}): SshPlan {
  return {
    env: plan.env,
    sshKey: plan.sshKey,
    sshPassword: plan.sshPassword,
    envId: plan.env.id,
    knownHostFingerprint: plan.env.hostKeyFingerprint ?? null,
    saveHostFingerprint: (fingerprint) => saveHostKeyFingerprint(plan.env.id, fingerprint),
  };
}

/** push the task's input attachments to the sandbox; failures are logged, never fatal */
export async function pushInputAttachments(
  taskId: string,
  briefData: { attachments?: Array<{ id: string; filename: string; mime: string; size: number; remotePath: string }> },
  sshPlan: SshPlan,
  envName: string,
  loadSshClient: () => Promise<Parameters<typeof pushTaskFiles>[0]>,
  onLine: (line: string) => void,
) {
  try {
    const inputFiles: Array<{ localPath: string; remoteName: string }> = [];
    for (const a of briefData.attachments ?? []) {
      if (await attachmentExists(taskId, a.id))
        inputFiles.push({ localPath: attachmentPath(taskId, a.id), remoteName: a.filename });
    }
    if (inputFiles.length) {
      const ClientCtor = await loadSshClient();
      await pushTaskFiles(ClientCtor, sshPlan, taskId, inputFiles);
      onLine(`[dispatch] pushed ${inputFiles.length} attachment(s) to ${envName}`);
    }
  } catch (e) {
    onLine(`[dispatch] attachment push failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** active-sibling scan for the staging sweep (#160): RUNNING runs of the task
 * EXCLUDING the settling run itself — its own status flips only later, in
 * writer.finish (after collect), so a self-inclusive check would block the
 * sweep forever and out/ would grow until the 50MB cap silently dropped every
 * later deliverable. */
export function sweepActiveSiblingScan(ex: DbExecutor, taskId: string, runId: string) {
  return asDb(ex)
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .innerJoin(taskMessages, eq(taskMessages.id, taskRuns.messageId))
    .where(and(eq(taskRuns.status, RUN_STATUS.RUNNING), eq(taskMessages.taskId, taskId), ne(taskRuns.id, runId)));
}

/** remove the task's whole sandbox staging dir once NO OTHER run of the task is
 * still running (SPEC attachments flow). Best-effort on both sides: a failed
 * sweep never fails a settle, and an active sibling just leaves staging for its
 * own settle to sweep. Returns whether the sweep ran. */
export async function sweepTaskSandboxWhenLastRun(taskId: string, runId: string, sshPlan: SshPlan): Promise<boolean> {
  try {
    const active = await sweepActiveSiblingScan(db, taskId, runId);
    if (active.length > 0) return false;
    const { loadClient } = await import('./ssh-exec.util');
    const ClientCtor = await loadClient();
    await cleanupTaskFiles(ClientCtor, sshPlan, taskId);
    return true;
  } catch {
    /* sweep is best-effort */
    return false;
  }
}

/** after a run settles: collect agent outputs from the sandbox, then clean up when last.
 * Returns the message-attachment tokens for the collected images (RESULT-MESSAGE
 * ATTACHMENTS, SPEC 2026-10-31) — the caller appends them to the run message body. */
export async function settleAttachments(
  taskId: string,
  runId: string,
  sshPlan: SshPlan,
  _status: FinishedStatus,
): Promise<{ collected: number; tokens: string[] }> {
  try {
    const { loadClient } = await import('./ssh-exec.util');
    const ClientCtor = await loadClient();
    const tmp = mkdtempSync(path.join(tmpdir(), 'tandem-out-'));
    try {
      const collected = await collectRunOutputs(ClientCtor, sshPlan, taskId, tmp, COLLECTION_MAX_BYTES);
      const stored: ResultFile[] = [];
      for (const f of collected) {
        try {
          const bytes = Buffer.from(await Bun.file(f.localPath).arrayBuffer());
          const mime = normalizeMime(guessMime(f.filename));
          if (!mimeAllowed(mime)) continue;
          const sha256 = sha256Hex(bytes);
          // idempotent collect (#160): staging survives while a sibling run is
          // active, so the next collect re-lists files this task already stores
          // — a byte-identical output must not become a second row (it would
          // also re-embed old images into every new result message)
          const dups = await db
            .select({ id: taskAttachments.id })
            .from(taskAttachments)
            .where(
              and(
                eq(taskAttachments.taskId, taskId),
                eq(taskAttachments.kind, 'output'),
                eq(taskAttachments.sha256, sha256),
              ),
            );
          if (dups.length > 0) continue;
          const id = uuidv7();
          await saveAttachmentBytes(taskId, id, bytes);
          await db.insert(taskAttachments).values({
            id,
            taskId,
            runId,
            kind: 'output',
            // sandbox filenames are agent-controlled text — never stored raw
            filename: sanitizeFilename(f.filename),
            mime,
            size: bytes.byteLength,
            sha256,
            createdBy: null,
          });
          stored.push({ id, filename: sanitizeFilename(f.filename), mime, size: bytes.byteLength });
        } catch (e) {
          // one unreadable/unstorable file never aborts the rest of the batch
          consola.warn(`[settle] skipped collected output '${f.filename}': ${String(e)}`);
        }
      }
      if (collected.length) {
        await logRun(taskId, runId, `collected ${collected.length} output file(s)`, {
          outputs: collected.map((c) => c.filename),
        });
        await publishChange(CHANGE_RESOURCE.TASK_ACTIVITY, CHANGE_ACTION.CREATE);
      }
      // sweep staging on the SUCCESS path too (#160): the old code returned
      // before cleanup, so out/ only ever grew until the 50MB cap silently
      // dropped all later deliverables
      await sweepTaskSandboxWhenLastRun(taskId, runId, sshPlan);
      return { collected: collected.length, tokens: resultImageTokens(stored) };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  } catch {
    /* collection is best-effort; never fail a finished run over it */
  }
  await sweepTaskSandboxWhenLastRun(taskId, runId, sshPlan);
  return { collected: 0, tokens: [] };
}

export function guessMime(filename: string) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    zip: 'application/zip',
  };
  return map[ext] ?? 'application/octet-stream';
}

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { v7 as uuidv7 } from 'uuid';

import { CHANGE_RESOURCE, CHANGE_ACTION, SECRET_USAGE } from '#shared/enums';
import { RUN_STATUS, REVIEW_STATUS, type FinishedStatus } from '#shared/enums';
import type { ReviewEnvelope, RunEnvelope } from '#shared/run-verdict';
import { STATUS } from '#shared/status';
// One shared verdict contract: the review brief renders the SAME JSON envelope as the
// work brief (owner no-truncation law: title/description/result/activity ship WHOLE).

import {
  attachmentExists,
  attachmentPath,
  COLLECTION_MAX_BYTES,
  mimeAllowed,
  normalizeMime,
  readAttachmentBytes,
  sanitizeFilename,
  saveAttachmentBytes,
  sha256Hex,
} from './attachments.util';
/** everything the dispatched agent needs, decrypted; returns null pieces when unconfigured */
import { buildBrief, loadBriefData } from './brief.service';
import { promptImageSplit } from './prompt-images.util';
import { recordProposals } from './proposals.service';
import { resultImageTokens, type ResultFile } from './result-attachments.util';
import { recordVerdict } from './review.service';
import type { SshPlan } from './ssh-exec.util';
import { collectRunOutputs, cleanupTaskFiles, pushTaskFiles, ensureOutDir } from './ssh-files.util';
import { appendMessageAttachments, createRunMessage, updateRunMessageBody } from './thread.service';
import { submitResult, askQuestion } from './workflow.service';

export async function loadDispatchPlan(taskId: string) {
  const taskRows = await db.query.tasks.findMany({
    columns: { id: true, title: true, description: true, assigneeId: true },
    where: { id: { eq: taskId } },
    orderBy: { createdAt: 'asc' },
  });
  const task = taskRows[0];
  if (!task) throw new Error('task not found');
  if (!task.assigneeId) throw new Error('task has no assignee');
  const aiRows = await db.query.aiEmployees.findMany({
    columns: {
      userId: true,
      environmentId: true,
      executable: true,
      providerId: true,
      model: true,
      apiKeySecretId: true,
    },
    where: { userId: { eq: task.assigneeId } },
    orderBy: { userId: 'asc' },
  });
  const ai = aiRows[0];
  if (!ai) throw new Error('assignee is not an AI employee');
  const envRows = await db.query.environments.findMany({
    columns: {
      id: true,
      name: true,
      host: true,
      port: true,
      username: true,
      secretId: true,
      secretUsage: true,
      hostKeyFingerprint: true,
    },
    where: { id: { eq: ai.environmentId } },
    orderBy: { createdAt: 'asc' },
  });
  const env = envRows[0];
  /* v8 ignore next -- FK prevents a dangling environment_id; kept as defense */
  if (!env) throw new Error('agent environment not found');
  const empRows = await db.query.user.findMany({
    columns: { name: true },
    where: { id: { eq: ai.userId } },
    orderBy: { createdAt: 'asc' },
  });

  // SSH secret (key or password)
  let sshKey: string | undefined;
  let sshPassword: string | undefined;
  if (env.secretId) {
    // FK is ON DELETE SET NULL: a present secretId implies the row exists
    const secret = nonNull(
      (
        await db.query.vaultSecrets.findMany({
          columns: { ciphertext: true },
          where: { id: { eq: env.secretId } },
          orderBy: { createdAt: 'asc' },
        })
      )[0],
    );
    const plain = decryptSecret(secret.ciphertext);
    if (env.secretUsage === SECRET_USAGE.PASSWORD) sshPassword = plain;
    else sshKey = plain;
  }

  // agent LLM access: provider endpoint + key + pinned model
  let llmEnv: Record<string, string> = {};
  if (ai.providerId && ai.model && ai.apiKeySecretId) {
    // all three FKs resolve (SET NULL on delete): present ids imply present rows
    const provider = nonNull(
      (
        await db.query.modelProviders.findMany({
          columns: { baseUrl: true },
          where: { id: { eq: ai.providerId } },
          orderBy: { createdAt: 'asc' },
        })
      )[0],
    );
    const keySecret = nonNull(
      (
        await db.query.vaultSecrets.findMany({
          columns: { ciphertext: true },
          where: { id: { eq: ai.apiKeySecretId } },
          orderBy: { createdAt: 'asc' },
        })
      )[0],
    );
    const key = decryptSecret(keySecret.ciphertext);
    llmEnv = {
      CUSTOM_API_KEY: key,
      CUSTOM_BASE_URL: provider.baseUrl,
      HERMES_MODEL: ai.model,
    };
  }

  /* v8 ignore next -- ?? 'agent' arm is FK-protected (ai row implies user row) */
  return { task, ai, env, envName: env.name, agentName: empRows[0]?.name ?? 'agent', sshKey, sshPassword, llmEnv };
}

/** the employee's latest ACP session on this task (per task PER EMPLOYEE —
 * reviewers and assignees never share a session). Null = first turn: session/new. */
async function lastSessionFor(taskId: string, employeeId: string, excludeRunId?: string) {
  // excludeRunId: the CURRENT run's own row (inserted before the turn, sessionId
  // still null) would otherwise shadow the previous run's session.
  const conds = [eq(taskMessages.taskId, taskId), eq(taskRuns.employeeId, employeeId)];
  if (excludeRunId) conds.push(ne(taskRuns.id, excludeRunId));
  const row = (
    await db
      .select({ sessionId: taskRuns.sessionId })
      .from(taskRuns)
      .innerJoin(taskMessages, eq(taskMessages.id, taskRuns.messageId))
      .where(and(...conds))
      .orderBy(desc(taskRuns.startedAt))
      .limit(1)
  )[0];
  return row?.sessionId ?? null;
}

/** REVIEW LAW: a review turn runs ON the task but BY a reviewer — their own AI env,
 * their own ACP session (per task PER EMPLOYEE — never the assignee's session), and a
 * review brief carrying the submitted result. Envelope settles the verdict at run end. */
export async function loadReviewPlan(taskId: string, reviewerId: string, resultBody: string) {
  const base = await loadDispatchPlanFor(reviewerId, taskId);
  // reviewer's own session on this task = their latest run's sessionId (null on first)
  return { ...base, review: { reviewerId, resultBody, resumeSessionId: await lastSessionFor(taskId, reviewerId) } };
}

/** loadDispatchPlan for a specific employee (the reviewer), not the task assignee.
 * Same secret/LLM loading as the assignee path — a reviewer turn is a real run. */
async function loadDispatchPlanFor(employeeId: string, taskId: string) {
  const taskRows = await db.query.tasks.findMany({
    columns: { id: true, title: true, description: true, assigneeId: true },
    where: { id: { eq: taskId } },
    orderBy: { createdAt: 'asc' },
  });
  const task = taskRows[0];
  if (!task) throw new Error('task not found');
  const aiRows = await db.query.aiEmployees.findMany({
    columns: {
      userId: true,
      environmentId: true,
      executable: true,
      providerId: true,
      model: true,
      apiKeySecretId: true,
    },
    where: { userId: { eq: employeeId } },
    orderBy: { userId: 'asc' },
  });
  const ai = aiRows[0];
  if (!ai) throw new Error('reviewer is not an AI employee');
  const envRows = await db.query.environments.findMany({
    columns: {
      id: true,
      name: true,
      host: true,
      port: true,
      username: true,
      secretId: true,
      secretUsage: true,
      hostKeyFingerprint: true,
    },
    where: { id: { eq: ai.environmentId } },
    orderBy: { createdAt: 'asc' },
  });
  const env = envRows[0];
  /* v8 ignore next -- FK prevents a dangling environment_id; kept as defense */
  if (!env) throw new Error('agent environment not found');
  const empRows = await db.query.user.findMany({
    columns: { name: true },
    where: { id: { eq: employeeId } },
    orderBy: { createdAt: 'asc' },
  });

  let sshKey: string | undefined;
  let sshPassword: string | undefined;
  if (env.secretId) {
    const secret = nonNull(
      (
        await db.query.vaultSecrets.findMany({
          columns: { ciphertext: true },
          where: { id: { eq: env.secretId } },
          orderBy: { createdAt: 'asc' },
        })
      )[0],
    );
    const plain = decryptSecret(secret.ciphertext);
    if (env.secretUsage === SECRET_USAGE.PASSWORD) sshPassword = plain;
    else sshKey = plain;
  }
  let llmEnv: Record<string, string> = {};
  if (ai.providerId && ai.model && ai.apiKeySecretId) {
    const provider = nonNull(
      (
        await db.query.modelProviders.findMany({
          columns: { baseUrl: true },
          where: { id: { eq: ai.providerId } },
          orderBy: { createdAt: 'asc' },
        })
      )[0],
    );
    const keySecret = nonNull(
      (
        await db.query.vaultSecrets.findMany({
          columns: { ciphertext: true },
          where: { id: { eq: ai.apiKeySecretId } },
          orderBy: { createdAt: 'asc' },
        })
      )[0],
    );
    const key = decryptSecret(keySecret.ciphertext);
    llmEnv = { CUSTOM_API_KEY: key, CUSTOM_BASE_URL: provider.baseUrl, HERMES_MODEL: ai.model };
  }
  /* v8 ignore next -- ?? 'reviewer' arm is FK-protected (ai row implies user row) */
  return { task, ai, env, envName: env.name, agentName: empRows[0]?.name ?? 'reviewer', sshKey, sshPassword, llmEnv };
}

/** REVIEW LAW: the brief for a review turn — reviewer identity, the task under
 * review, the submitted result, and the verdict contract. Ends like every brief:
 * the SAME RunVerdictSchema JSON envelope (no marker fallback — only the parser's
 * contract parses), and NO truncation — the reviewer must see the whole ticket. */
/** routing folded into the envelope: map the settled verdict's optional fields to proposal payloads */
function envelopeProposals(envelope: RunEnvelope | null): RoutingProposal[] {
  const payloads: RoutingProposal[] = [];
  if (envelope?.subtasks?.length) payloads.push({ kind: PROPOSAL_KIND.SUBTASKS, items: envelope.subtasks });
  if (envelope?.reassign)
    payloads.push({
      kind: PROPOSAL_KIND.REASSIGN,
      targetName: envelope.reassign.assigneeName,
      reason: envelope.reassign.reason,
    });
  return payloads;
}

/** the env blob written to the remote agent's stdin (never argv) */
/** hermes reads the API key for a custom endpoint from <VENDOR>_API_KEY where VENDOR is
 * derived from the endpoint HOST (registrable label, api./www. stripped, non-alnum -> _,
 * uppercase). Mirrors hermes_cli _host_derived_api_key; empty string when the host yields
 * nothing (IPs, loopback, single-label hosts). */
export function hostDerivedKeyEnv(baseUrl: string) {
  try {
    const host = new URL(baseUrl).hostname;
    const tld = nonNull(host.split('.').pop());
    if (host === 'localhost' || /\d/.test(tld)) return 'CUSTOM_API_KEY';
    const labels = host.split('.').filter(Boolean);
    while (labels.length && ['api', 'www'].includes(nonNull(labels[0]))) labels.shift();
    if (labels.length < 2) return 'CUSTOM_API_KEY';
    const vendor = nonNull(labels[labels.length - 2])
      .replace(/[^a-zA-Z0-9]/g, '')
      .toUpperCase();
    if (!vendor || !/^[A-Z]/.test(vendor) || ['OPENAI', 'OPENROUTER', 'OLLAMA'].includes(vendor))
      return 'CUSTOM_API_KEY';
    return `${vendor}_API_KEY`;
  } catch {
    return 'CUSTOM_API_KEY';
  }
}

/** shell-quote one value for a single-quoted blob slot: every ' becomes '\''
 * (close quote, escaped quote, reopen) so nothing can break out of the assignment */
export function shQ(v: string) {
  return v.replace(/'/g, `'\\''`);
}

export function buildEnvBlob(plan: Awaited<ReturnType<typeof loadDispatchPlan>>, _tandemUrl: string) {
  return [
    // set -a: every assignment below is EXPORTED to the agent child process env
    // (plain `VAR=...` after `.` only sets shell vars, hermes would see nothing)
    'set -a',
    // non-interactive ssh shells get a minimal PATH (~/.local/bin, ~/.bun/bin missing) —
    // extend it or the agent executable is 'command not found' (exit 127)
    // double quotes: $HOME/$PATH must EXPAND when the blob is sourced
    `PATH="/opt/hermes/bin:$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:/usr/local/bin:$PATH"`,
    `CUSTOM_BASE_URL='${shQ(plan.llmEnv.CUSTOM_BASE_URL ?? '')}'`,
    // hermes's credential ladder is HOST-GATED: for host a.b.example.com it reads only
    // <BEXAMPLE>_API_KEY (registrable label of the host), NOT CUSTOM_API_KEY, for the chat
    // call. Emit BOTH so any OpenAI-compat client works while hermes finds its key.
    `CUSTOM_API_KEY='${shQ(plan.llmEnv.CUSTOM_API_KEY ?? '')}'`,
    // hermes host-gated credential (mirrors _host_derived_api_key: drop leading api./www.,
    // take the registrable label pair, strip non-alnum, uppercase) + keep CUSTOM_API_KEY for
    // every other OpenAI-compatible client
    `${hostDerivedKeyEnv(plan.llmEnv.CUSTOM_BASE_URL ?? '')}='${shQ(plan.llmEnv.CUSTOM_API_KEY ?? '')}'`,
    `HERMES_MODEL='${shQ(plan.llmEnv.HERMES_MODEL ?? '')}'`,
    `TANDEM_TASK_ID='${shQ(plan.task.id)}'`,
    // NO HERMES_HOME override: the host's own agent home is the employee's
    // environment; per-task isolation comes from ACP sessions, not homes

    'set +a',
    // shQ escapes EVERY value: titles carry quotes/spaces; an unescaped ' would
    // close the assignment and execute injected words when the blob is sourced
    `TANDEM_TASK_TITLE='${shQ(plan.task.title)}'`,
    '',
  ].join('\n');
}

/** fake runner: synthetic streaming emitter for tests/CI */
export function fakeScriptFromEnv(envName?: 'TANDEM_FAKE_SCRIPT' | 'TANDEM_FAKE_SCRIPT_REVIEW'): string[] | null {
  const raw = env[envName ?? 'TANDEM_FAKE_SCRIPT'];
  if (!raw) return null;
  return raw.split('\n');
}

function fakeRun(onLine: (line: string) => void, scriptOverride?: string[]): RunHandle {
  const script = scriptOverride ??
    fakeScriptFromEnv() ?? [
      'thinking about the task…',
      'reading context',
      'working: step 1/3',
      'working: step 2/3',
      'working: step 3/3',
      'RESULT: task complete as requested',
    ];

  const runId = uuidv7();
  // executor assigns synchronously — definite-assignment asserted for the CFA
  let finished!: (v: { status: FinishedStatus; exitCode: number | null }) => void;
  const promise = new Promise<{ status: FinishedStatus; exitCode: number | null }>((resolve) => {
    finished = resolve;
  });
  void (async () => {
    const delay = Number(env.TANDEM_FAKE_DELAY_MS ?? 30);
    for (const line of script) {
      await new Promise((r) => setTimeout(r, delay));
      onLine(line);
    }
    // TANDEM_FAKE_FAIL=1: the fake run FAILS (drives the backoff ladder in tests
    // without the ssh emitError choreography, which hung under CI coverage runs)
    const failed = env.TANDEM_FAKE_FAIL === '1';
    finished({ status: failed ? RUN_STATUS.FAILED : RUN_STATUS.DONE, exitCode: failed ? 1 : 0 });
  })();
  return { runId, finished: promise };
}

/**
 * Run-level retry law (owner ruling 2026-10-28, task 01a182f2): a dispatch intent is
 * ONE run row. Transport failures (SSH refused, plan load, pre-turn errors) are
 * retried by BullMQ ON THE SAME ROW — same frozen prompt, appended output — so a
 * retry can never drift the prompt the way scan-loop re-enqueues did (fresh
 * `buildBrief` per attempt pulled newer context each time). Attempts live on the
 * job (DISPATCH_ATTEMPTS + custom ladder backoff); `task_runs.attempts` mirrors the
 * executions for the UI. The task-level ladder (fail_streak/dispatch_after) now only
 * governs the NEXT dispatch intent after a run settles FAILED.
 */
export const DISPATCH_ATTEMPTS = 4; // first try + 3 retries = the 60s/5m/15m ladder

/** per-agent dispatch queue name (bullmq forbids ':' in queue names). The optional
 * namespace is set per test file (worker-setup.ts) so a file's queues can never
 * collide with a zombie worker left by a previous file sharing the same process
 * and redis db index. */
export function dispatchQueueName(employeeId: string) {
  const ns = process.env.TANDEM_QUEUE_NS;
  return `${DISPATCH_QUEUE_PREFIX}${ns ? `-${ns}` : ''}-${employeeId}`;
}

export const DISPATCH_QUEUE_PREFIX = 'tandem-dispatch';

/** the dispatch job payload — the RUN is the unit of work (identity only; the row
 * owns the frozen prompt/output, never the queue) */
export type DispatchJob = {
  runId: string;
  tandemUrl: string;
  reviewBy?: string;
  resultBody?: string;
};

/** dispatch intent options — review turns carry their reviewer + the body being reviewed */
export type DispatchOpts = { reviewBy?: string; resultBody?: string };

/** DISPATCH CLAIM LAW (#162, SPEC): the dispatch claim is ONE conditional flip of
 * the task row — status must still be in a ready-category when the flip lands; the
 * flip's RETURNING arbitrates every concurrent claimant (scan tick × direct paths ×
 * manual dispatch) so exactly one wins. 0 rows = lost the race = stale duplicate:
 * the caller aborts PRE-INSERT (no run row, no dispatch note, no thread turn, no
 * per-agent job, no cap consumption — a stale dispatch call must quietly no-op). */
export async function claimTaskForDispatch(taskId: string): Promise<boolean> {
  const ready = await db.query.taskStatuses.findMany({
    columns: { id: true },
    where: { category: { eq: 'ready' } },
  });
  if (ready.length === 0) return false;
  const claimed = await db
    .update(tasks)
    .set({ status: STATUS.doing, updatedAt: new Date() })
    .where(
      and(
        eq(tasks.id, taskId),
        inArray(
          tasks.status,
          ready.map((s) => s.id),
        ),
      ),
    )
    .returning({ id: tasks.id });
  return claimed.length > 0;
}

/** create the run row for a dispatch intent: claim the task (conditional flip — the
 * race arbiter), load the plan, write the dispatch note, create the run's thread
 * turn, freeze the brief on the row. Transport-neutral — the caller enqueues
 * {runId} (or executes inline in tests). Returns null when the claim was lost —
 * the loser is a stale duplicate and must not insert anything (CLAIM LAW #162). */
export async function createRun(
  taskId: string,
  opts?: DispatchOpts,
): Promise<{ runId: string; employeeId: string } | null> {
  // the claim lands BEFORE the plan load: a failure after a won flip leaves a doing
  // task with no run row, which the LIVENESS SWEEP recovers — never a zombie
  // RUNNING row. Review turns run ON the task but must not claim it: flipping
  // in-review → doing here would make the human verdict verbs
  // (approve/request-changes) throw on the status gate — only the ASSIGNEE's
  // dispatch owns the doing transition.
  if (!opts?.reviewBy && !(await claimTaskForDispatch(taskId))) return null;

  const plan: Awaited<ReturnType<typeof loadDispatchPlan>> & {
    review?: Awaited<ReturnType<typeof loadReviewPlan>>['review'];
  } = opts?.reviewBy // eslint-disable-line @typescript-eslint/consistent-type-definitions -- union widening
    ? await loadReviewPlan(taskId, opts.reviewBy, opts.resultBody ?? '')
    : await loadDispatchPlan(taskId);

  // claim: dispatch note is written BEFORE the run row exists so its createdAt
  // sits BEFORE the run's startedAt — the timeline shows "dispatched" above the
  // result card, not after it
  const runId = uuidv7();
  await logRun(
    taskId,
    runId,
    `dispatched to ${plan.agentName} on ${plan.envName}`,
    { dispatched: true },
    {
      publishActivity: false,
    },
  );
  // the run's thread turn: message first (blank body — settle parses the result
  // into it), the run row links the task through it
  const messageId = await createRunMessage({ taskId, authorId: plan.ai.userId });
  await db.insert(taskRuns).values({
    id: runId,
    messageId,
    employeeId: plan.ai.userId,
    environmentId: plan.env.id,
    status: RUN_STATUS.RUNNING,
    output: '',
    attempts: 1,
  });
  // only now is the thread turn complete — publish the activity ping here so a
  // listener rebuilding off it sees the run bubble, not a message-less gap
  await publishChange(CHANGE_RESOURCE.TASK_ACTIVITY, CHANGE_ACTION.CREATE);
  // the doing flip happened at the CLAIM (claimTaskForDispatch above — #162);
  // review turns never claimed the task (see the claim block)
  await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);

  // freeze the brief NOW (the drift fix): every attempt of this run replays exactly
  // this prompt — no rebuild at retry time. Review turns compose through the SAME
  // buildBrief in review mode (org, company, task-under-review, relay, submitted
  // result, collected evidence, verdict contract — one composer, no parallel system).
  const briefData = await loadBriefData(taskId, plan.ai.userId);
  let reviewCtx: { resultBody: string; verdictsSoFar: string[] } | undefined;
  if (plan.review) {
    const { verdictsSoFarFor } = await import('./review.service');
    reviewCtx = { resultBody: plan.review.resultBody, verdictsSoFar: await verdictsSoFarFor(taskId) };
  }
  const brief = buildBrief({
    ...briefData,
    outDir: `~/.tandem/${taskId}/attachments/out/`,
    review: reviewCtx,
  });
  await db.update(taskRuns).set({ prompt: brief }).where(eq(taskRuns.id, runId));

  return { runId, employeeId: plan.ai.userId };
}

/** settle a failed run's TASK side: bounce to ready under the fail-streak ladder so
 * the NEXT dispatch intent waits. Only the latest run of a still-doing task may
 * bounce it — a cancelled/done/waiting-answer/in-review task is never resurrected. */
async function bounceTaskAfterRun(taskId: string, runId: string, output: string) {
  const current = (
    await db.query.tasks.findMany({
      columns: { status: true, failStreak: true },
      where: { id: { eq: taskId } },
      orderBy: { createdAt: 'asc' },
    })
  )[0];
  // only bounce the task if this was its latest run (shared findFirst, #163)
  const latestRunId = await latestRunIdForTask(taskId);
  if (latestRunId !== runId || current?.status !== STATUS.doing) return;
  const streak = current.failStreak + 1;
  const waitMs = backoffFor(streak, output);
  const bounced = await db
    .update(tasks)
    .set({
      status: STATUS.todo,
      failStreak: streak,
      dispatchAfter: new Date(Date.now() + waitMs),
      updatedAt: new Date(),
    })
    // atomic re-check of the guard: a settle/cancel between read and write wins
    .where(and(eq(tasks.id, taskId), eq(tasks.status, STATUS.doing)))
    .returning({ id: tasks.id });
  if (!bounced.length) return; // raced with a status change — nothing to retry
  /* v8 ignore next -- the catch only guards a task deleted between the update and the log */
  await logRun(taskId, runId, `retry scheduled in ${Math.round(waitMs / 60_000)} min (streak ${streak})`, {
    backoffMs: waitMs,
  }).catch(() => {});
  await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
}

/** enqueue a created run for execution on the per-agent queue. Throws when redis is
 * unreachable — callers decide the retry (the scan's next tick / the RPC error). */
export async function enqueueRun(runId: string, employeeId: string, tandemUrl: string, opts?: DispatchOpts) {
  const hub = await redisQueue();
  await hub.enqueue<DispatchJob>(
    dispatchQueueName(employeeId),
    { runId, tandemUrl, reviewBy: opts?.reviewBy, resultBody: opts?.resultBody },
    {
      attempts: DISPATCH_ATTEMPTS,
      jobId: runId,
      removeOnComplete: true,
      // custom strategy = the owner ladder; the worker registers the fn
      backoff: { type: 'custom' },
    },
  );
}

/** dispatch a task to its AI assignee: create the run row (frozen brief) and enqueue
 * it. Returns immediately — the per-agent worker executes; BullMQ retries transport
 * failures on the same row. */
export async function dispatchTask(
  taskId: string,
  tandemUrl: string,
  opts?: DispatchOpts,
): Promise<{ runId: string | null }> {
  // a lost claim is a stale duplicate: quiet no-op, nothing inserted (CLAIM LAW #162)
  const claimed = await createRun(taskId, opts);
  if (!claimed) return { runId: null };
  const { runId, employeeId } = claimed;
  try {
    await enqueueRun(runId, employeeId, tandemUrl, opts);
  } catch (e) {
    // redis down between create and enqueue: settle the row so it can't hang RUNNING
    // past its timeout, and bounce the task — the scan/ladder re-dispatches a fresh
    // intent with a fresh frozen brief
    const msg = e instanceof Error ? e.message : String(e);
    await bounceTaskAfterRun(taskId, runId, `[dispatch] enqueue failed: ${msg}`);
    await db
      .update(taskRuns)
      .set({
        status: RUN_STATUS.FAILED,
        exitCode: null,
        output: `[dispatch] enqueue failed: ${msg}`,
        finishedAt: new Date(),
      })
      .where(and(eq(taskRuns.id, runId), eq(taskRuns.status, RUN_STATUS.RUNNING)));
    throw e;
  }
  return { runId };
}

/** REVIEW LAW: a review turn's envelope writes the reviewer's verdict row
 * ([RESULT] approve / [BLOCKED] change request); a verdict-less review NEVER
 * silently approves — it parks on the owner. */
async function settleReviewVerdict(taskId: string, reviewerId: string, envelope: ReviewEnvelope | null) {
  // IDENTITY MAP (final spec 2026-10-29): the review envelope kind IS the verdict —
  // no translation layer. `escalate` is the one non-settling kind: a referral.
  if (envelope?.kind === 'approved') {
    /* v8 ignore next -- empty-text fallback */
    await recordVerdict(taskId, reviewerId, REVIEW_STATUS.APPROVED, envelope.text || 'approved by review', 'ai');
  } else if (envelope?.kind === 'rejected') {
    /* v8 ignore next -- empty-text fallback */
    await recordVerdict(taskId, reviewerId, REVIEW_STATUS.REJECTED, envelope.text || 'rejected by review', 'ai');
  } else if (envelope?.kind === 'request_change') {
    /* v8 ignore next -- empty-text fallback */
    await recordVerdict(
      taskId,
      reviewerId,
      REVIEW_STATUS.CHANGE_REQUESTED,
      envelope.text || 'changes requested by review',
      'ai',
    );
  } else if (envelope?.kind === 'escalate') {
    // referral: swap the reviewer up-chain on the TASK roster; a stuck referral
    // (no eligible target) parks the round on the owner with the why intact
    const { escalateReview } = await import('./review.service');
    await escalateReview(taskId, reviewerId, envelope.text || 'escalate for reviewing');
  } else {
    // verdict-less review: the reviewer's turn never produced a verdict envelope —
    // a transport-class failure of the review, so re-dispatch its turn ONCE before
    // parking on the owner (bound: a reviewer with 2+ runs this round has already
    // had its second chance — that parks instead of looping forever)
    const reviewRuns = await db.query.taskRuns.findMany({
      columns: { id: true },
      where: { employeeId: { eq: reviewerId }, message: { taskId: { eq: taskId } } },
    });
    if (reviewRuns.length <= 1) {
      const { dispatchAiReviewTurns } = await import('./review.service');
      await dispatchAiReviewTurns(taskId);
      await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
      return;
    }
    const { parkRound } = await import('./review.service');
    await parkRound(taskId, 'review finished without a verdict after a re-dispatch — needs a human');
  }
  await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
}

/** settle a DONE run: parse the envelope, route proposals, submit the result (or
 * park the task on a question / a verdict-less review). Returns 'backoff' when the
 * settle itself failed (the task ladder stays armed). */
async function settleDoneRun(
  taskId: string,
  runId: string,
  plan: { review?: { resultBody: string }; ai: { userId: string } },
  buffer: string,
): Promise<'settled' | 'backoff'> {
  const { parseRunEnvelope, parseReviewEnvelope } = await import('#shared/run-verdict');
  // the ACP 400-char force-flush splits ONE long JSON verdict into adjacent buffer
  // lines; rejoin the last 3 lines with NO separator (the newline was a flush
  // artifact — a '\n' join would re-split identically) once before falling back.
  // REVIEW turns parse the REVIEW vocabulary (strict — legacy result/blocked kinds
  // are unknown here and read as verdict-less).
  const rejoin = (out: string) => out.split('\n').slice(-3).join('');
  const reviewEnvelope = plan.review ? (parseReviewEnvelope(buffer) ?? parseReviewEnvelope(rejoin(buffer))) : null;
  const workEnvelope = plan.review ? null : (parseRunEnvelope(buffer) ?? parseRunEnvelope(rejoin(buffer)));

  // routing folded into the envelope (owner ruling 2026-10-26): proposals are read
  // ONLY from the agent's own verdict line — echoed task content can never route.
  // REVIEW runs are exempt: a reviewer's envelope must never route work — recording
  // proposals on the REVIEWER's chain could self-reassign the task to the reviewer.
  if (!plan.review) {
    const payloads = envelopeProposals(workEnvelope);
    if (payloads.length) {
      try {
        await recordProposals(taskId, runId, plan.ai.userId, payloads);
      } catch {
        /* proposal recording is best-effort */
      }
    }
  }
  try {
    if (plan.review) {
      await settleReviewVerdict(taskId, plan.ai.userId, reviewEnvelope);
    } else if (workEnvelope && (workEnvelope.kind === 'question' || workEnvelope.kind === 'blocked')) {
      // empty-text envelopes fall back to the kind as the question body
      /* v8 ignore next */
      await askQuestion(taskId, plan.ai.userId, workEnvelope.text || workEnvelope.kind);
    } else {
      // the REAL result rides the submit — the supervisor's review brief needs it
      // (envelope text, else the tail of what the agent actually said)
      /* v8 ignore next -- bare 'run complete' only when the agent said nothing at all */
      const resultBody =
        workEnvelope?.text?.trim() || buffer.trim().split('\n').slice(-12).join('\n').slice(-2000) || 'run complete';
      await submitResult(taskId, plan.ai.userId, resultBody);
    }
  } catch (e) {
    // a submit/verdict failure is REAL: log it and take the retry/backoff path —
    // swallowing it here then resetting failStreak wedged the task with no retry
    /* v8 ignore start */ // needs a mid-flight workflow mutation so submit throws; the reaper/backoff arms cover the ladder
    consola.error(`[settle] task ${taskId} run ${runId} settle failed: ${e instanceof Error ? e.message : String(e)}`);
    await bounceTaskAfterRun(taskId, runId, buffer);
    return 'backoff';
  }
  // streak reset only AFTER a successful settle — a failed settle must keep the ladder
  await db.update(tasks).set({ failStreak: 0, dispatchAfter: null, updatedAt: new Date() }).where(eq(tasks.id, taskId));
  return 'settled';
}

/** flush/finish machinery for one run execution: appends streamed lines to the row
 * (chunked sql-concat, never a full rewrite) and settles the row exactly once. */
function createRunWriter(runId: string, initial: string, messageId: string) {
  let buffer = initial;
  let flushedLen = buffer.length;
  let lastFlush = 0;
  let flushing = false;
  const onLine = (line: string) => {
    buffer = `${buffer}${buffer ? '\n' : ''}${line}`;
    const now = Date.now();
    if (now - lastFlush > flushMs() && !flushing) {
      lastFlush = now;
      flushing = true;
      // sql-concat append of ONLY the new slice: rewriting the whole buffer each flush is
      // O(n²) write amplification on long runs. Same RUNNING predicate as before — once
      // finish() flips the status, late lines are dropped (finish writes the full buffer).
      const chunk = buffer.slice(flushedLen);
      flushedLen = buffer.length;
      void db
        .update(taskRuns)
        .set({ output: sql`coalesce(${taskRuns.output}, '') || ${chunk}` })
        .where(and(eq(taskRuns.id, runId), eq(taskRuns.status, RUN_STATUS.RUNNING)))
        .then(() => publishChange(CHANGE_RESOURCE.RUNS, CHANGE_ACTION.UPDATE))
        // flush is best-effort; finish() writes the final tail. A late flush can
        // race teardown (test DB drops, shutdown) — swallow, never an unhandled rejection.
        .catch(
          // v8 ignore next 2
          () => {},
        )
        .finally(() => {
          flushing = false;
        });
    }
  };

  // flushSync: the retry path throws right after logging — the cadence flush would
  // never fire, and the NEXT attempt seeds its buffer from the row, so the error
  // text must already be on it
  const flushSync = async () => {
    const chunk = buffer.slice(flushedLen);
    flushedLen = buffer.length;
    await db
      .update(taskRuns)
      .set({ output: sql`coalesce(${taskRuns.output}, '') || ${chunk}` })
      .where(and(eq(taskRuns.id, runId), eq(taskRuns.status, RUN_STATUS.RUNNING)));
  };

  // finish() settles a run EXACTLY once: a settle error after DONE must not re-enter
  // as FAILED (overwriting submitted work), and a second call must not double-settle
  let settled = false;
  const finish = async (
    taskId: string,
    status: FinishedStatus,
    exitCode: number | null,
    plan: { review?: { resultBody: string }; ai: { userId: string } },
    attachTokens: string[] = [],
  ) => {
    if (settled) return;
    settled = true;
    // RUNNING predicate: a reaper-settled row is never overwritten mid-flight
    await db
      .update(taskRuns)
      .set({ status, exitCode, output: buffer, finishedAt: new Date() })
      .where(and(eq(taskRuns.id, runId), eq(taskRuns.status, RUN_STATUS.RUNNING)));
    // the thread message body becomes the parsed result of the final output
    // the run bubble carries the VERDICT on review turns (one response per turn)
    await updateRunMessageBody(messageId, buffer, Boolean(plan.review));
    // RESULT-MESSAGE ATTACHMENTS: collected images ride the message body — appended
    // AFTER the body write (the parse owns the body; the append must not be overwritten)
    await appendMessageAttachments(messageId, attachTokens);
    // no settle note: the run card's status pill (completed / failed exit N) IS the
    // verdict — a separate 'run finished' pill only duplicated it in the thread
    if (status === RUN_STATUS.DONE) {
      await settleDoneRun(taskId, runId, plan, buffer);
    } else {
      await bounceTaskAfterRun(taskId, runId, buffer);
    }
    await publishChange(CHANGE_RESOURCE.RUNS, CHANGE_ACTION.UPDATE);
    // re-publish the thread feed only after the body rewrite AND the settle: the
    // pre-dispatch ping predates both, so a listener holding that snapshot would
    // keep a blank run bubble with a stale status
    await publishChange(CHANGE_RESOURCE.TASK_ACTIVITY, CHANGE_ACTION.CREATE);
  };

  return {
    onLine,
    flushSync,
    finish,
    get buffer() {
      return buffer;
    },
  };
}

/** classify + settle a failed attempt: a PRE-TURN transport failure with attempts
 * left returns 'retry' (the caller rethrows for BullMQ backoff — same row, frozen
 * prompt); anything else settles the run FAILED and bounces the task. */
async function attemptFailed(
  runId: string,
  taskId: string,
  attempt: { attempt: number; maxAttempts: number },
  turnStarted: boolean,
  writer: ReturnType<typeof createRunWriter>,
  plan: { review?: { resultBody: string }; ai: { userId: string } },
  e: unknown,
): Promise<{ status: FinishedStatus; exitCode: number | null } | 'retry'> {
  const message = e instanceof Error ? e.message : String(e);
  writer.onLine(`[dispatch] ${message}`);
  // run-level retry: only PRE-TURN transport failures replay the row (the turn
  // never reached the agent); post-turn errors settle as a real FAILED verdict
  const retryable = !turnStarted && attempt.attempt < attempt.maxAttempts;
  if (!turnStarted) {
    // record the execution + the error on the row synchronously (see flushSync):
    // the next attempt seeds its buffer from the row — the error text must be on it
    if (retryable)
      writer.onLine(`[retry] attempt ${attempt.attempt}/${attempt.maxAttempts} failed — retrying with backoff`);
    await writer.flushSync();
    await db
      .update(taskRuns)
      .set({ attempts: attempt.attempt })
      .where(and(eq(taskRuns.id, runId), eq(taskRuns.status, RUN_STATUS.RUNNING)));
    if (retryable) return 'retry';
  }
  try {
    // no-ops when finish() already settled this run (e.g. after DONE)
    await writer.finish(taskId, RUN_STATUS.FAILED, null, plan);
  } catch (finishError) {
    /* v8 ignore start -- needs settle + finish to BOTH fail; injected in e2e only */
    // the worker slot frees via return — a failing settle must never leak it
    consola.error(`[dispatch] run ${runId} finish failed: ${String(finishError)}`);
    /* v8 ignore stop */
  }
  return { status: RUN_STATUS.FAILED, exitCode: null };
}

/** GUARD-SETTLE LAW (#162, SPEC): a guard that refuses to execute a still-RUNNING
 * row settles it FIRST — returning without settling left the row RUNNING until the
 * reaper (run-timeout + margin), during which it counted toward the agent's
 * per-agent cap: the agent silently claimed nothing. The TASK is untouched — the
 * winning intent owns the task's status. */
async function settleZombieRow(runId: string, priorOutput: string, reason: string) {
  await db
    .update(taskRuns)
    .set({
      status: RUN_STATUS.FAILED,
      exitCode: null,
      output: priorOutput ? `${priorOutput}\n[dispatch] ${reason}` : `[dispatch] ${reason}`,
      finishedAt: new Date(),
    })
    .where(and(eq(taskRuns.id, runId), eq(taskRuns.status, RUN_STATUS.RUNNING)));
}

/** fetch the run row for execution; the stale-job guard settles a still-RUNNING
 * relic it refuses (GUARD-SETTLE LAW #162) and returns null. */
async function runnableRowOrSettled(runId: string) {
  const row = await db.query.taskRuns.findFirst({
    columns: { id: true, status: true, attempts: true, output: true, prompt: true, messageId: true },
    where: { id: { eq: runId } },
    with: { message: { columns: { taskId: true } } },
  });
  // stale-job guard: the run was settled while this attempt sat in backoff
  // (cancelled + reaped, human re-dispatched) — nothing to execute, job completes
  if (!row || row.status !== RUN_STATUS.RUNNING || !row.message) {
    // GUARD-SETTLE (#162): a RUNNING row the guard refuses (a message-less relic)
    // settles here instead of lingering RUNNING for the reaper
    if (row && row.status === RUN_STATUS.RUNNING)
      await settleZombieRow(row.id, row.output, 'stale dispatch job — the run was settled elsewhere');
    return null;
  }
  return row;
}

/** superseded-intent check + settle: a NEWER run for this task (re-arm, human
 * re-dispatch) makes this job stale — replaying it would apply an outdated prompt.
 * The loser row settles FAILED (GUARD-SETTLE #162) instead of RUNNING for the
 * reaper while consuming a per-agent cap slot. */
async function supersededByNewerRun(runId: string, taskId: string, priorOutput: string) {
  const newestRunId = await latestRunIdForTask(taskId);
  if (newestRunId === runId) return false;
  await settleZombieRow(runId, priorOutput, 'superseded by a newer run of this task — never executed');
  return true;
}

/** execute ONE attempt of a created run on the per-agent queue worker (or inline in
 * tests). Retryable PRE-TURN failures throw so BullMQ backs off and replays the SAME
 * row with its frozen prompt; post-turn failures and the final attempt settle the run. */
export async function executeRun(
  runId: string,
  tandemUrl: string,
  attempt: { attempt: number; maxAttempts: number; reviewBy?: string; resultBody?: string },
): Promise<{ status: FinishedStatus; exitCode: number | null }> {
  const row = await runnableRowOrSettled(runId);
  if (!row) return { status: RUN_STATUS.FAILED, exitCode: null };
  // the helper's guard refused any message-less row — asserted here for the CFA
  const taskId = nonNull(row.message).taskId;
  if (await supersededByNewerRun(runId, taskId, row.output)) return { status: RUN_STATUS.FAILED, exitCode: null };

  const plan: Awaited<ReturnType<typeof loadDispatchPlan>> & {
    review?: Awaited<ReturnType<typeof loadReviewPlan>>['review'];
  } = attempt.reviewBy // eslint-disable-line @typescript-eslint/consistent-type-definitions -- union widening
    ? await loadReviewPlan(taskId, attempt.reviewBy, attempt.resultBody ?? '')
    : await loadDispatchPlan(taskId);
  // THE drift fix: the prompt is the one frozen at createRun — never rebuilt here
  const brief = nonNull(row.prompt, 'run prompt (frozen at createRun)');
  const briefData = await loadBriefData(taskId, plan.ai.userId);
  const writer = createRunWriter(runId, row.output ?? '', row.messageId);
  const { onLine } = writer;

  // turnStarted marks the point of no return for retries: once the ACP stream is
  // open the agent may have begun acting on the prompt — a failure past it is a
  // real FAILED verdict, never a transport replay (double-apply protection)
  let turnStarted = false;
  try {
    if (env.TANDEM_FAKE_RUNNER === '1') {
      // fake path: deterministic per-(task, employee) session so resume
      // separation (assignee vs reviewer) is exercised without a real ACP host
      const fakeSession = `${plan.review ? 'rev' : 'sess'}-${taskId}-${plan.ai.userId}`;
      await db.update(taskRuns).set({ sessionId: fakeSession }).where(eq(taskRuns.id, runId));
      const fake = fakeRun(
        onLine,
        fakeScriptFromEnv(plan.review ? 'TANDEM_FAKE_SCRIPT_REVIEW' : 'TANDEM_FAKE_SCRIPT') ?? undefined,
      );
      const r = await fake.finished;
      await writer.finish(taskId, r.status, r.exitCode, plan);
      return r;
    }
    const envBlob = buildEnvBlob(plan, tandemUrl);
    const { openAcpSshStream } = await import('./acp-ssh.util');
    const { runAcpTurn, verdictFor } = await import('./acp.client');
    const { loadClient: loadSshClient } = await import('./ssh-exec.util');
    // host-key law (SPEC: Environments): the plan carries the TOFU trust state —
    // every transport (push, out-dir, ACP stream, collect) verifies through it
    const sshPlan = sshPlanOf(plan);
    // push input attachments (idempotent; no-op when none)
    await pushInputAttachments(taskId, briefData, sshPlan, plan.envName, loadSshClient, onLine);
    // PROMPT-INLINE IMAGES (SPEC 2026-10-31): selected input images ride the turn
    // as ACP image content blocks (staging already covered every input — this is
    // additive; an unreadable file logs and leaves the agent the staged copy)
    const inlineImages = await readInlineImages(taskId, briefData.attachments, onLine);
    // ALWAYS pre-create the out dir so deliverables have a real home (7d06bae0
    // law). Fired detached: mkdir lands in ms, the turn starts immediately, and a
    // slow/unreachable host must never delay dispatch.
    /* v8 ignore next 2 -- the catch only fires on ssh failure before the turn */
    void ensureOutDir(await loadSshClient(), sshPlan, taskId).catch((e) =>
      onLine(`[dispatch] out-dir prepare failed: ${e instanceof Error ? e.message : String(e)}`),
    );
    // one ACP prompt turn: session per task (resume when one exists)
    const stream = await openAcpSshStream(sshPlan, envBlob, plan.ai.executable, onLine);
    // the turn is ON THE HOST from here: a failure past this point is the agent's
    // run (terminal verdict), never a transport replay — replaying the same prompt
    // after a half-executed turn would double-apply work
    turnStarted = true;
    const acp = await runAcpTurn({
      stream,
      onSessionOpen: (steer) => {
        liveSteers.set(runId, steer);
      },
      /* v8 ignore next -- the review-resume arm runs on real ACP review turns;
       * unit coverage drives review turns through the fake runner */
      resumeSessionId: plan.review ? plan.review.resumeSessionId : await lastSessionFor(taskId, plan.ai.userId, runId),
      prompt: brief,
      images: inlineImages,
      timeoutMs: await getRunTimeoutMs(),
      onLine,
    });
    // sessions are per (task, employee) — every run persists its own session id
    await db.update(taskRuns).set({ sessionId: acp.sessionId }).where(eq(taskRuns.id, runId));
    const { status, exitCode } = verdictFor(acp.stopReason);
    // evidence ordering (final spec 2026-10-29): an assignee run that submits for
    // review must have its collected artifacts on the server BEFORE the reviewer's
    // brief is frozen — bounded await (slow/unreachable host must never stall the
    // verdict path). Review runs collect detached: their outputs feed no one.
    const collectP = settleAttachments(taskId, runId, sshPlan, status).catch(() => undefined);
    // tokens are only known once collect returns: work runs bound the wait at 20s —
    // a slower collect still stores its rows (gallery) but the message ships without
    // them. Review runs collect detached: their outputs feed no one.
    let attachTokens: string[] = [];
    if (!plan.review)
      attachTokens =
        (await Promise.race([collectP, new Promise<undefined>((r) => setTimeout(() => r(undefined), 20_000))]))
          ?.tokens ?? [];
    else void collectP;
    await writer.finish(taskId, status, exitCode, plan, attachTokens);
    return { status, exitCode };
  } catch (e) {
    /* v8 ignore next -- service throws are Error by construction */
    const failed = await attemptFailed(runId, taskId, attempt, turnStarted, writer, plan, e);
    if (failed === 'retry') throw e instanceof Error ? e : new Error(String(e));
    return failed;
  } finally {
    // STEER-HOOK LIFECYCLE (#161): the hook is transient — it closes over the ACP
    // client context, so surviving the run pins one connection per finished run
    // forever (silent RSS climb). Every settle path (done, failed, retry-throw)
    // exits through here exactly once; a retry-throw never registered a hook (the
    // set happens only after the session opens, past the retryable window).
    liveSteers.delete(runId);
  }
}

/** integration-test convenience: create the run and execute attempt 1 INLINE (what
 * the worker does) without the queue — the caller awaits the verdict directly. */
/** runs for one task, newest first — RUN-TRANSCRIPT LAW (#130 slice 2): the
 * snapshot select never carries transcript text; `output` rides ONLY for the
 * RUNNING run (live stream surface) and `prompt` never rides (flags instead) */
export function runsListScan(ex: DbExecutor, taskId: string) {
  return asDb(ex)
    .select({
      id: taskRuns.id,
      employeeId: taskRuns.employeeId,
      environmentId: taskRuns.environmentId,
      status: taskRuns.status,
      attempts: taskRuns.attempts,
      exitCode: taskRuns.exitCode,
      ...transcriptSnapshotColumns(),
      startedAt: taskRuns.startedAt,
      finishedAt: taskRuns.finishedAt,
    })
    .from(taskRuns)
    .innerJoin(taskMessages, eq(taskMessages.id, taskRuns.messageId))
    .where(eq(taskMessages.taskId, taskId));
}

export async function listRuns(taskId: string) {
  const rows = await runsListScan(db, taskId);
  return rows.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}
