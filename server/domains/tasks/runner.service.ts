import { consola } from 'consola';
import { and, desc, eq, ne, sql } from 'drizzle-orm';

import { PROPOSAL_KIND } from '#shared/enums';
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

import type { RoutingProposal } from '../../../app/utils/task-thread';
import { db } from '../../db/index';
import { tasks, taskRuns, taskActivity, taskAttachments, taskMessages } from '../../db/schema';
import { env } from '../kernel/env';
import { publishChange } from '../kernel/kernel';
import { decryptSecret } from '../vault/secret/secret-crypto.service';

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
 * session/prompt on the open stream); gone the moment the turn settles */
const liveSteers = new Map<string, (text: string) => Promise<boolean>>();

/** test seam: register/clear a fake live turn so steerRun's arms are unit-testable */
export function __setLiveSteerForTests(runId: string, fn: ((text: string) => Promise<boolean>) | null) {
  if (fn) liveSteers.set(runId, fn);
  else liveSteers.delete(runId);
}

/** the task's live run id, if any — status/assignee edits are locked while it runs */
export async function runningRunIdForTask(taskId: string): Promise<string | null> {
  const msg = await db.query.taskMessages.findFirst({
    columns: { id: true },
    where: { taskId: { eq: taskId } },
    orderBy: { createdAt: 'desc', id: 'desc' },
    with: { run: { columns: { id: true, status: true } } },
  });
  return msg?.run && msg.run.status === RUN_STATUS.RUNNING ? msg.run.id : null;
}

/** steer the task's live run. 'stopped' = no live run (safe to dispatch);
 *  'refused' = a run is live but this turn can't take input (fake runner) */
export async function steerRun(taskId: string, text: string): Promise<'steered' | 'stopped' | 'refused'> {
  // message-first: the task is reached through the run's thread message
  const msg = await db.query.taskMessages.findFirst({
    columns: { id: true },
    where: { taskId: { eq: taskId } },
    orderBy: { createdAt: 'desc', id: 'desc' },
    with: { run: { columns: { id: true, status: true } } },
  });
  const runId = msg?.run && msg.run.status === RUN_STATUS.RUNNING ? msg.run.id : null;
  if (!runId) return 'stopped';
  const steer = liveSteers.get(runId);
  if (!steer) return 'refused';
  const ok = await steer(text).catch(() => false);
  if (!ok) liveSteers.delete(runId);
  return ok ? 'steered' : 'refused';
}

async function logRun(taskId: string, runId: string, body: string, meta: Record<string, unknown> = {}) {
  await db
    .insert(taskActivity)
    .values({ id: uuidv7(), taskId, kind: 'status', authorId: null, body, meta: { ...meta, runId } });
  await publishChange(CHANGE_RESOURCE.TASK_ACTIVITY, CHANGE_ACTION.CREATE);
  await publishChange(CHANGE_RESOURCE.RUNS, CHANGE_ACTION.UPDATE);
}

/** push the task's input attachments to the sandbox; failures are logged, never fatal */
export async function pushInputAttachments(
  taskId: string,
  briefData: { attachments?: Array<{ id: string; filename: string; mime: string; size: number; remotePath: string }> },
  sshPlan: { env: { host: string; port: string; username: string }; sshKey?: string; sshPassword?: string },
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

/** after a run settles: collect agent outputs from the sandbox, then clean up when last */
export async function settleAttachments(
  taskId: string,
  runId: string,
  sshPlan: { env: { host: string; port: string; username: string }; sshKey?: string; sshPassword?: string },
  _status: FinishedStatus,
) {
  try {
    const { loadClient } = await import('./ssh-exec.util');
    const ClientCtor = await loadClient();
    const tmp = mkdtempSync(path.join(tmpdir(), 'tandem-out-'));
    try {
      const collected = await collectRunOutputs(ClientCtor, sshPlan, taskId, tmp, COLLECTION_MAX_BYTES);
      for (const f of collected) {
        try {
          const bytes = Buffer.from(await Bun.file(f.localPath).arrayBuffer());
          const mime = normalizeMime(guessMime(f.filename));
          if (!mimeAllowed(mime)) continue;
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
            sha256: sha256Hex(bytes),
            createdBy: null,
          });
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
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  } catch {
    /* collection is best-effort; never fail a finished run over it */
  }
  // cleanup only when no other run of this task is still running
  try {
    const active = await db
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .innerJoin(taskMessages, eq(taskMessages.id, taskRuns.messageId))
      .where(and(eq(taskRuns.status, RUN_STATUS.RUNNING), eq(taskMessages.taskId, taskId)));
    if (active.length === 0) {
      const { loadClient } = await import('./ssh-exec.util');
      const ClientCtor = await loadClient();
      await cleanupTaskFiles(ClientCtor, sshPlan, taskId);
    }
  } catch {
    /* cleanup is best-effort */
  }
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
import { RunVerdictSchema, type RunEnvelope } from '#shared/run-verdict';
import { STATUS } from '#shared/status';
// One shared verdict contract: the review brief renders the SAME JSON envelope as the
// work brief (owner no-truncation law: title/description/result/activity ship WHOLE).
import { renderOutputContract } from '#shared/structured-output';

import {
  attachmentExists,
  attachmentPath,
  COLLECTION_MAX_BYTES,
  mimeAllowed,
  normalizeMime,
  sanitizeFilename,
  saveAttachmentBytes,
  sha256Hex,
} from './attachments.util';
/** everything the dispatched agent needs, decrypted; returns null pieces when unconfigured */
import { buildBrief, loadBriefData } from './brief.service';
import { recordProposals } from './proposals.service';
import { recordVerdict } from './review.service';
import { collectRunOutputs, cleanupTaskFiles, pushTaskFiles, ensureOutDir } from './ssh-files.util';
import { createRunMessage, updateRunMessageBody } from './thread.service';
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
    columns: { id: true, name: true, host: true, port: true, username: true, secretId: true, secretUsage: true },
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
    columns: { id: true, name: true, host: true, port: true, username: true, secretId: true, secretUsage: true },
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

function reviewBrief(
  reviewerName: string,
  taskTitle: string,
  taskDescription: string,
  briefData: {
    recentActivity: Array<{ kind: string; authorName: string | null; body: string | null }>;
    relay: boolean;
  },
  resultBody: string,
  relay = false,
) {
  const lines: string[] = [];
  lines.push(
    `You are ${reviewerName}, reviewing a submitted result. This is a REVIEW turn — do the work again is NOT the goal; verify and verdict.`,
  );
  lines.push('');
  // relay law: on the reviewer's repeat turns the ticket lives in their session
  if (!relay) {
    lines.push('TASK UNDER REVIEW');
    lines.push(`Title: ${taskTitle}`);
    if (taskDescription.trim()) lines.push(`Description: ${taskDescription.trim()}`);
    lines.push('');
  }
  lines.push('SUBMITTED RESULT (by the assignee)');
  /* v8 ignore next -- '(no result text)' is defensive; submits carry a body */
  lines.push(resultBody || '(no result text)');
  /* v8 ignore start -- fresh tasks have no activity; the block is optional by design */
  if (briefData.recentActivity.length) {
    lines.push('');
    lines.push('Recent activity (oldest first):');
    for (const a of briefData.recentActivity) lines.push(`- ${a.kind} by ${a.authorName ?? 'system'}: ${a.body ?? ''}`);
  }
  /* v8 ignore stop */
  lines.push('');
  lines.push(
    renderOutputContract(RunVerdictSchema, {
      // same verbs the verdict parser settles on: result = approve, blocked =
      // change request, question = park on the owner; a verdict-less review never approves
      intro:
        'VERDICT — end your response with exactly one JSON line (no code fence). kind "result" APPROVES the submission, "blocked" sends it back to the assignee with your note, "question" parks the task on the owner:',
      examples: [
        '{"kind": "result", "body": "<verdict note — approval>"}',
        '{"kind": "blocked", "body": "<what must change — sent back to the assignee>"}',
        '{"kind": "question", "body": "<blocking question for the owner>"}',
      ],
    }),
  );
  return lines.join('\n');
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

/** dispatch a task to its AI assignee. Records the run row, streams output into it. */
export async function dispatchTask(
  taskId: string,
  tandemUrl: string,
  opts?: { reviewBy?: string; resultBody?: string },
) {
  const plan: Awaited<ReturnType<typeof loadDispatchPlan>> & {
    review?: Awaited<ReturnType<typeof loadReviewPlan>>['review'];
  } = opts?.reviewBy // eslint-disable-line @typescript-eslint/consistent-type-definitions -- union widening
    ? await loadReviewPlan(taskId, opts.reviewBy, opts.resultBody ?? '')
    : await loadDispatchPlan(taskId);

  // claim: dispatch note is written BEFORE the run row exists so its createdAt
  // sits BEFORE the run's startedAt — the timeline shows "dispatched" above the
  // result card, not after it
  const runId = uuidv7();
  await logRun(taskId, runId, `dispatched to ${plan.agentName} on ${plan.envName}`, { dispatched: true });
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
  });
  // review turns run ON the task but must not claim it: flipping in-review → doing
  // here would make the human verdict verbs (approve/request-changes) throw on the
  // status gate — only the ASSIGNEE's dispatch owns the doing transition
  if (!plan.review)
    await db.update(tasks).set({ status: STATUS.doing, updatedAt: new Date() }).where(eq(tasks.id, taskId));
  await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);

  let buffer = '';
  /** how much of buffer the run row already holds — each flush appends ONLY the new slice */
  let flushedLen = 0;
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

  // DONE verdict: the envelope decides the workflow. [QUESTION]/[BLOCKED] park the
  // task on the owner (waiting-answer + answer obligation) instead of completing
  // it; [RESULT] (or none) submits for review / completes as before.
  const settleReviewVerdict = async (envelope: RunEnvelope | null) => {
    // REVIEW LAW: this run WAS a review turn BY a reviewer on this task. The
    // envelope writes their verdict row ([RESULT] approve / [BLOCKED] change request);
    // a verdict-less review NEVER silently approves — it parks on the owner.
    if (envelope?.kind === 'blocked') {
      /* v8 ignore next -- empty-text fallback */
      await recordVerdict(
        taskId,
        plan.ai.userId,
        REVIEW_STATUS.CHANGE_REQUESTED,
        envelope.text || 'changes requested by review',
        'ai',
      );
    } else if (envelope?.kind === 'question') {
      /* v8 ignore next -- empty-text fallback */
      await askQuestion(taskId, plan.ai.userId, envelope.text || 'question during review');
    } else if (envelope?.kind === 'result') {
      /* v8 ignore next -- empty-text fallback */
      await recordVerdict(taskId, plan.ai.userId, REVIEW_STATUS.APPROVED, envelope.text || 'approved by review', 'ai');
    } else {
      await askQuestion(taskId, plan.ai.userId, 'review finished without a verdict — approve or request changes');
    }
    await publishChange(CHANGE_RESOURCE.TASKS, CHANGE_ACTION.UPDATE);
  };

  const settleDoneRun = async () => {
    const { parseRunEnvelope } = await import('#shared/run-verdict');
    let envelope = parseRunEnvelope(buffer);
    if (!envelope) {
      // the ACP 400-char force-flush splits ONE long JSON verdict into adjacent buffer
      // lines; rejoin the last 3 lines with NO separator (the newline was a flush
      // artifact — a '\n' join would re-split identically) once before falling back
      envelope = parseRunEnvelope(buffer.split('\n').slice(-3).join(''));
    }

    // routing folded into the envelope (owner ruling 2026-10-26): proposals are read
    // ONLY from the agent's own verdict line — echoed task content can never route.
    // REVIEW runs are exempt: a reviewer's envelope must never route work — recording
    // proposals on the REVIEWER's chain could self-reassign the task to the reviewer.
    if (!plan.review) {
      const payloads = envelopeProposals(envelope);
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
        await settleReviewVerdict(envelope);
      } else if (envelope && (envelope.kind === 'question' || envelope.kind === 'blocked')) {
        // empty-text envelopes fall back to the kind as the question body
        /* v8 ignore next */
        await askQuestion(taskId, plan.ai.userId, envelope.text || envelope.kind);
      } else {
        // the REAL result rides the submit — the supervisor's review brief needs it
        // (envelope text, else the tail of what the agent actually said)
        /* v8 ignore next -- bare 'run complete' only when the agent said nothing at all */
        const resultBody =
          envelope?.text?.trim() || buffer.trim().split('\n').slice(-12).join('\n').slice(-2000) || 'run complete';
        await submitResult(taskId, plan.ai.userId, resultBody);
      }
    } catch (e) {
      // a submit/verdict failure is REAL: log it and take the retry/backoff path —
      // swallowing it here then resetting failStreak wedged the task with no retry
      /* v8 ignore start */ // needs a mid-flight workflow mutation so submit throws; the reaper/backoff arms cover the ladder
      consola.error(
        `[settle] task ${taskId} run ${runId} settle failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      await scheduleRetryBackoff();
      return;
    }
    // streak reset only AFTER a successful settle — a failed settle must keep the ladder
    await db
      .update(tasks)
      .set({ failStreak: 0, dispatchAfter: null, updatedAt: new Date() })
      .where(eq(tasks.id, taskId));
  };

  // bounce to ready, but back off: consecutive failures (and quota walls) must not
  // turn into a 5s retry storm — see BACKOFF_STEPS_MS / QUOTA_PATTERN
  const scheduleRetryBackoff = async () => {
    const current = (
      await db.query.tasks.findMany({
        columns: { status: true, failStreak: true },
        where: { id: { eq: taskId } },
        orderBy: { createdAt: 'asc' },
      })
    )[0];
    // resurrection guard: only THIS task's latest run may bounce it, and only while
    // the task still sits in the doing state this run owns — a cancelled/done/
    // waiting-answer/in-review task must never be dragged back into the ready queue
    const latestRun = (
      await db
        .select({ id: taskRuns.id })
        .from(taskRuns)
        .innerJoin(taskMessages, eq(taskMessages.id, taskRuns.messageId))
        .where(eq(taskMessages.taskId, taskId))
        .orderBy(desc(taskRuns.startedAt))
        .limit(1)
    )[0];
    if (latestRun?.id !== runId || current?.status !== STATUS.doing) return;
    const streak = current.failStreak + 1;
    const waitMs = backoffFor(streak, buffer);
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
  };

  // finish() settles a run EXACTLY once: a settle error after DONE must not re-enter
  // as FAILED (overwriting submitted work), and a second call must not double-settle
  let settled = false;
  const finish = async (status: FinishedStatus, exitCode: number | null) => {
    if (settled) return;
    settled = true;
    // RUNNING predicate: a reaper-settled row is never overwritten mid-flight
    await db
      .update(taskRuns)
      .set({ status, exitCode, output: buffer, finishedAt: new Date() })
      .where(and(eq(taskRuns.id, runId), eq(taskRuns.status, RUN_STATUS.RUNNING)));
    // the thread message body becomes the parsed result of the final output
    await updateRunMessageBody(messageId, buffer);
    // no settle note: the run card's status pill (completed / failed exit N) IS the
    // verdict — a separate 'run finished' pill only duplicated it in the thread
    if (status === RUN_STATUS.DONE) {
      await settleDoneRun();
    } else {
      await scheduleRetryBackoff();
    }
    await publishChange(CHANGE_RESOURCE.RUNS, CHANGE_ACTION.UPDATE);
  };

  const handle: RunHandle = {
    runId,
    finished: new Promise((resolve) => {
      void (async () => {
        try {
          const briefData = await loadBriefData(taskId, plan.ai.userId);
          const brief = plan.review
            ? reviewBrief(
                plan.agentName,
                plan.task.title,
                plan.task.description,
                briefData,
                plan.review.resultBody,
                briefData.relay,
              )
            : buildBrief({ ...briefData, outDir: `~/.tandem/${taskId}/attachments/out/` });
          // persist the exact prompt so the run is auditable from the task page
          await db.update(taskRuns).set({ prompt: brief }).where(eq(taskRuns.id, runId));
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
            await finish(r.status, r.exitCode);
            resolve(r);
            return;
          }
          const envBlob = buildEnvBlob(plan, tandemUrl);
          const { openAcpSshStream } = await import('./acp-ssh.util');
          const { runAcpTurn, verdictFor } = await import('./acp.client');
          const { loadClient: loadSshClient } = await import('./ssh-exec.util');
          const sshPlan = { env: plan.env, sshKey: plan.sshKey, sshPassword: plan.sshPassword };
          // push input attachments (idempotent; no-op when none)
          await pushInputAttachments(taskId, briefData, sshPlan, plan.envName, loadSshClient, onLine);
          // ALWAYS pre-create the out dir so deliverables have a real home (7d06bae0
          // law). Fired detached: mkdir lands in ms, the turn starts immediately, and a
          // slow/unreachable host must never delay dispatch.
          /* v8 ignore next 2 -- the catch only fires on ssh failure before the turn */
          void ensureOutDir(await loadSshClient(), sshPlan, taskId).catch((e) =>
            onLine(`[dispatch] out-dir prepare failed: ${e instanceof Error ? e.message : String(e)}`),
          );
          // one ACP prompt turn: session per task (resume when one exists)
          const stream = await openAcpSshStream(sshPlan, envBlob, plan.ai.executable, onLine);
          const acp = await runAcpTurn({
            stream,
            onSessionOpen: (steer) => {
              liveSteers.set(runId, steer);
            },
            /* v8 ignore next -- the review-resume arm runs on real ACP review turns;
             * unit coverage drives review turns through the fake runner */
            resumeSessionId: plan.review
              ? plan.review.resumeSessionId
              : await lastSessionFor(taskId, plan.ai.userId, runId),
            prompt: brief,
            timeoutMs: await getRunTimeoutMs(),
            onLine,
          });
          // sessions are per (task, employee) — every run persists its own session id
          await db.update(taskRuns).set({ sessionId: acp.sessionId }).where(eq(taskRuns.id, runId));
          const { status, exitCode } = verdictFor(acp.stopReason);
          // settle attachments DETACHED: collection/cleanup must never block the verdict
          void settleAttachments(taskId, runId, sshPlan, status);
          await finish(status, exitCode);
          resolve({ status, exitCode });
        } catch (e) {
          /* v8 ignore next -- service throws are Error by construction */
          onLine(`[dispatch] ${e instanceof Error ? e.message : String(e)}`);
          try {
            // no-ops when finish() already settled this run (e.g. after DONE)
            await finish(RUN_STATUS.FAILED, null);
          } catch (finishError) {
            /* v8 ignore start -- needs settle + finish to BOTH fail; injected in e2e only */
            // the worker slot frees via resolve — a failing settle must never leak it
            consola.error(`[dispatch] run ${runId} finish failed: ${String(finishError)}`);
            /* v8 ignore stop */
          }
          resolve({ status: RUN_STATUS.FAILED, exitCode: null });
        }
      })();
    }),
  };
  return handle;
}

/** runs for one task, newest first */
export async function listRuns(taskId: string) {
  const rows = await db
    .select({
      id: taskRuns.id,
      employeeId: taskRuns.employeeId,
      environmentId: taskRuns.environmentId,
      status: taskRuns.status,
      exitCode: taskRuns.exitCode,
      output: taskRuns.output,
      prompt: taskRuns.prompt,
      startedAt: taskRuns.startedAt,
      finishedAt: taskRuns.finishedAt,
    })
    .from(taskRuns)
    .innerJoin(taskMessages, eq(taskMessages.id, taskRuns.messageId))
    .where(eq(taskMessages.taskId, taskId));
  return rows.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}
