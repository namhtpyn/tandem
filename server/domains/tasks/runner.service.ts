// Agent runner: dispatch a task to its AI assignee over SSH, stream stdout
// back, persist a capped tail on the run row. Secrets (SSH identity, agent
// LLM key) are decrypted in memory only and NEVER placed on argv — they ride
// a stdin env blob inside the remote shell, per the M5 law.
//
// TANDEM_FAKE_RUNNER=1 short-circuits SSH with a synthetic emitter so CI and
// local e2e can exercise the full dispatch→stream→finish loop with no host.
import { eq, and } from 'drizzle-orm'
import { db } from '../../db'
import { tasks, taskRuns, taskActivity, taskAttachments, aiEmployees, environments, modelProviders, vaultSecrets, vaultAudit, user as userTable } from '../../db/schema'
import { decryptSecret } from '../vault/vault-crypto.service'
import { publishChange } from '../kernel/kernel'

export const TAIL_MAX_LINES = 100

// stream-flush cadence; overridable so tests can exercise the flush path quickly
const FLUSH_MS = Number(process.env.TANDEM_RUN_FLUSH_MS ?? 500)

// hard cap on one run; a hung agent (frozen process, TCP never drops) becomes a failure
export const RUN_TIMEOUT_MS = Number(process.env.TANDEM_RUN_TIMEOUT_MS ?? 30 * 60_000)

// failure backoff ladder: consecutive failures -> wait before the next claim
const BACKOFF_STEPS_MS = [60_000, 5 * 60_000, 15 * 60_000] // 1min, 5min, 15min cap

/** quota/limit signatures in run output jump straight to the longest backoff tier */
const QUOTA_PATTERN = /(402|429|insufficient[ _]?(quota|credit)|rate.?limit|out of (usage|credits|quota)|exceeded your|billing)/i

export function backoffFor(failStreak: number, output: string): number {
  const quota = QUOTA_PATTERN.test(output)
  if (quota) return BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1]!
  return BACKOFF_STEPS_MS[Math.min(Math.max(failStreak - 1, 0), BACKOFF_STEPS_MS.length - 1)]!
}

export interface RunHandle {
  runId: string
  finished: Promise<{ status: 'done' | 'failed', exitCode: number | null }>
}

function tail(text: string, maxLines = TAIL_MAX_LINES): string {
  const lines = text.split('\n')
  return lines.length <= maxLines ? text : lines.slice(-maxLines).join('\n')
}

async function logRun(taskId: string, runId: string, body: string, meta: Record<string, unknown> = {}) {
  await db.insert(taskActivity).values({ id: crypto.randomUUID(), taskId, kind: 'status', authorId: null, body, meta: { ...meta, runId } })
  await publishChange('taskActivity', 'create')
  await publishChange('runs', 'update')
}

/** push the task's input attachments to the sandbox; failures are logged, never fatal */
export async function pushInputAttachments(
  taskId: string,
  briefData: { attachments?: Array<{ id: string, filename: string, mime: string, size: number, remotePath: string }> },
  sshPlan: { env: { host: string, port: string, username: string }, sshKey?: string, sshPassword?: string },
  envName: string,
  loadSshClient: () => Promise<Parameters<typeof pushTaskFiles>[0]>,
  onLine: (line: string) => void,
) {
  try {
    const inputFiles = (briefData.attachments ?? []).filter(a => attachmentExists(a.id)).map(a => ({
      localPath: attachmentPath(a.id),
      remoteName: a.filename,
    }))
    if (inputFiles.length) {
      const ClientCtor = await loadSshClient()
      await pushTaskFiles(ClientCtor, sshPlan, taskId, inputFiles)
      onLine(`[dispatch] pushed ${inputFiles.length} attachment(s) to ${envName}`)
    }
  }
  catch (e) {
    onLine(`[dispatch] attachment push failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** after a run settles: collect agent outputs from the sandbox, then clean up when last */
export async function settleAttachments(taskId: string, runId: string, sshPlan: { env: { host: string, port: string, username: string }, sshKey?: string, sshPassword?: string }, _status: 'done' | 'failed') {
  try {
    const { loadClient } = await import('./ssh-exec.util')
    const ClientCtor = await loadClient()
    const tmp = mkdtempSync(join(tmpdir(), 'tandem-out-'))
    try {
      const collected = await collectRunOutputs(ClientCtor, sshPlan, taskId, tmp, COLLECTION_MAX_BYTES)
      for (const f of collected) {
        const bytes = readFileSync(f.localPath)
        const mime = normalizeMime(guessMime(f.filename))
        if (!mimeAllowed(mime)) continue
        const id = crypto.randomUUID()
        saveAttachmentBytes(id, bytes)
        await db.insert(taskAttachments).values({ id, taskId, runId, kind: 'output', filename: f.filename, mime, size: bytes.byteLength, sha256: sha256Hex(bytes), createdBy: null })
      }
      if (collected.length) {
        await logRun(taskId, runId, `collected ${collected.length} output file(s)`, { outputs: collected.map(c => c.filename) })
        await publishChange('taskActivity', 'create')
      }
    }
    finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
  catch { /* collection is best-effort; never fail a finished run over it */ }
  // cleanup only when no other run of this task is still running
  try {
    const active = await db.select({ id: taskRuns.id }).from(taskRuns)
      .where(and(eq(taskRuns.taskId, taskId), eq(taskRuns.status, 'running')))
    if (active.length === 0) {
      const { loadClient } = await import('./ssh-exec.util')
      const ClientCtor = await loadClient()
      await cleanupTaskFiles(ClientCtor, sshPlan, taskId)
    }
  }
  catch { /* cleanup is best-effort */ }
}

export function guessMime(filename: string): string {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
    json: 'application/json', zip: 'application/zip',
  }
  return map[ext] ?? 'application/octet-stream'
}

/** everything the dispatched agent needs, decrypted; returns null pieces when unconfigured */
import { buildBrief, loadBriefData } from './brief.service'
import { attachmentExists, attachmentPath, COLLECTION_MAX_BYTES, mimeAllowed, normalizeMime, saveAttachmentBytes, sha256Hex } from './attachments.util'
import { collectRunOutputs, cleanupTaskFiles, pushTaskFiles } from './ssh-files.util'
import { recordProposals } from './proposals.service'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function loadDispatchPlan(taskId: string) {
  const taskRows = await db.select().from(tasks).where(eq(tasks.id, taskId))
  const task = taskRows[0]
  if (!task) throw new Error('task not found')
  if (!task.assigneeId) throw new Error('task has no assignee')
  const aiRows = await db.select().from(aiEmployees).where(eq(aiEmployees.userId, task.assigneeId))
  const ai = aiRows[0]
  if (!ai) throw new Error('assignee is not an AI employee')
  const envRows = await db.select().from(environments).where(eq(environments.id, ai.environmentId))
  const env = envRows[0]
  /* v8 ignore next -- FK prevents a dangling environment_id; kept as defense */
  if (!env) throw new Error('agent environment not found')
  const empRows = await db.select({ name: userTable.name }).from(userTable).where(eq(userTable.id, ai.userId))
  const actorId = 'system'

  // SSH secret (key or password)
  let sshKey: string | undefined
  let sshPassword: string | undefined
  if (env.secretId) {
    // FK is ON DELETE SET NULL: a present secretId implies the row exists
    const secret = (await db.select().from(vaultSecrets).where(eq(vaultSecrets.id, env.secretId)))[0]!
    const plain = decryptSecret(secret.ciphertext)
    if (env.secretUsage === 'password') sshPassword = plain
    else sshKey = plain
    await db.insert(vaultAudit).values({ id: crypto.randomUUID(), secretId: secret.id, secretName: secret.name, action: 'use', actorId })
  }

  // agent LLM access: provider endpoint + key + pinned model
  let llmEnv: Record<string, string> = {}
  if (ai.providerId && ai.model && ai.apiKeySecretId) {
    // all three FKs resolve (SET NULL on delete): present ids imply present rows
    const provider = (await db.select().from(modelProviders).where(eq(modelProviders.id, ai.providerId)))[0]!
    const keySecret = (await db.select().from(vaultSecrets).where(eq(vaultSecrets.id, ai.apiKeySecretId)))[0]!
    const key = decryptSecret(keySecret.ciphertext)
    await db.insert(vaultAudit).values({ id: crypto.randomUUID(), secretId: keySecret.id, secretName: keySecret.name, action: 'use', actorId })
    llmEnv = {
      CUSTOM_API_KEY: key,
      CUSTOM_BASE_URL: provider.baseUrl,
      HERMES_MODEL: ai.model,
    }
  }

  /* v8 ignore next -- ?? 'agent' arm is FK-protected (ai row implies user row) */
  return { task, ai, env, envName: env.name, agentName: empRows[0]?.name ?? 'agent', sshKey, sshPassword, llmEnv }
}

/** the env blob written to the remote agent's stdin (never argv) */
/** hermes reads the API key for a custom endpoint from <VENDOR>_API_KEY where VENDOR is
 * derived from the endpoint HOST (registrable label, api./www. stripped, non-alnum -> _,
 * uppercase). Mirrors hermes_cli _host_derived_api_key; empty string when the host yields
 * nothing (IPs, loopback, single-label hosts). */
export function hostDerivedKeyEnv(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname
    const tld = host.split('.').pop()!
    if (host === 'localhost' || /\d/.test(tld)) return 'CUSTOM_API_KEY'
    const labels = host.split('.').filter(Boolean)
    while (labels.length && ['api', 'www'].includes(labels[0]!)) labels.shift()
    if (labels.length < 2) return 'CUSTOM_API_KEY'
    const vendor = labels[labels.length - 2]!.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
    if (!vendor || !/^[A-Z]/.test(vendor) || ['OPENAI', 'OPENROUTER', 'OLLAMA'].includes(vendor)) return 'CUSTOM_API_KEY'
    return `${vendor}_API_KEY`
  }
  catch {
    return 'CUSTOM_API_KEY'
  }
}

export function buildEnvBlob(plan: Awaited<ReturnType<typeof loadDispatchPlan>>, tandemUrl: string): string {
  return [
    // set -a: every assignment below is EXPORTED to the agent child process env
    // (plain `VAR=...` after `.` only sets shell vars, hermes would see nothing)
    'set -a',
    // non-interactive ssh shells get a minimal PATH (~/.local/bin, ~/.bun/bin missing) —
    // extend it or the agent executable is 'command not found' (exit 127)
    // double quotes: $HOME/$PATH must EXPAND when the blob is sourced
    `PATH="/opt/hermes/bin:$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:/usr/local/bin:$PATH"`,
    `CUSTOM_BASE_URL='${plan.llmEnv.CUSTOM_BASE_URL ?? ''}'`,
    // hermes's credential ladder is HOST-GATED: for host a.b.example.com it reads only
    // <BEXAMPLE>_API_KEY (registrable label of the host), NOT CUSTOM_API_KEY, for the chat
    // call. Emit BOTH so any OpenAI-compat client works while hermes finds its key.
    `CUSTOM_API_KEY='${plan.llmEnv.CUSTOM_API_KEY ?? ''}'`,
    // hermes host-gated credential (mirrors _host_derived_api_key: drop leading api./www.,
    // take the registrable label pair, strip non-alnum, uppercase) + keep CUSTOM_API_KEY for
    // every other OpenAI-compatible client
    `${hostDerivedKeyEnv(plan.llmEnv.CUSTOM_BASE_URL ?? '')}='${plan.llmEnv.CUSTOM_API_KEY ?? ''}'`,
    `HERMES_MODEL='${plan.llmEnv.HERMES_MODEL ?? ''}'`,
    `TANDEM_TASK_ID='${plan.task.id}'`,
    // per-agent home; the official docker image drops privileges to uid 10000 and /root is
    // 0700 root-only, so when the target is a hermes container (/opt/data exists) the home
    // must live in the readable volume instead
    `HERMES_HOME="$( [ -d /opt/data ] && echo /opt/data/profiles/tandem-${plan.ai.userId} || echo /root/.hermes-profiles/tandem-${plan.ai.userId} )"`,

    'set +a',
    // single-quote EVERY value: titles contain spaces; unquoted words would be
    // executed as commands when the blob is sourced (exit 127)
    `TANDEM_TASK_TITLE='${plan.task.title.replace(/'/g, `'\\''`)}'`,
    '',
  ].join('\n')
}

/** the remote command: agent resumes its own profile home, prompt on argv-free stdin */
export function buildCommand(plan: Awaited<ReturnType<typeof loadDispatchPlan>>, brief: string): string {
  const exe = plan.ai.executable || 'hermes'
  const esc = (v: string) => v.replace(/'/g, `'\\''`)
  // hermes one-shot: -z prints only the final response (pipe-friendly); the per-agent
  // HERMES_HOME comes from the env blob (profiles must pre-exist, HERMES_HOME dirs don't);
  // -m/--provider select the model (CUSTOM_API_KEY/CUSTOM_BASE_URL also come from the blob)
  // prompt = per-task brief: identity, org chains, task context, output contract
  const model = plan.llmEnv.HERMES_MODEL ? ` -m '${esc(plan.llmEnv.HERMES_MODEL)}'` : ''
  return `${exe}${model} --provider custom -z '${esc(brief)}'`
}

/** fake runner: synthetic streaming emitter for tests/CI */
export function fakeScriptFromEnv(): string[] | null {
  const raw = process.env.TANDEM_FAKE_SCRIPT
  if (!raw) return null
  return raw.split('\n')
}

function fakeRun(onLine: (line: string) => void, scriptOverride?: string[]): RunHandle {
  const script = scriptOverride ?? fakeScriptFromEnv() ?? [
    'thinking about the task…',
    'reading context',
    'working: step 1/3',
    'working: step 2/3',
    'working: step 3/3',
    'RESULT: task complete as requested',
  ]

  const runId = crypto.randomUUID()
  let finished: (v: { status: 'done' | 'failed', exitCode: number | null }) => void
  const promise = new Promise<{ status: 'done' | 'failed', exitCode: number | null }>((resolve) => { finished = resolve })
  void (async () => {
    const delay = Number(process.env.TANDEM_FAKE_DELAY_MS ?? 30)
    for (const line of script) {
      await new Promise(r => setTimeout(r, delay))
      onLine(line)
    }
    finished!({ status: 'done', exitCode: 0 })
  })()
  return { runId, finished: promise }
}

/** dispatch a task to its AI assignee. Records the run row, streams output into it. */
export async function dispatchTask(taskId: string, tandemUrl: string): Promise<RunHandle> {
  const plan = await loadDispatchPlan(taskId)

  // claim: working -> the assignee is on it
  const runId = crypto.randomUUID()
  await db.insert(taskRuns).values({
    id: runId,
    taskId,
    employeeId: plan.ai.userId,
    environmentId: plan.env.id,
    status: 'running',
    output: '',
  })
  await db.update(tasks).set({ status: 'doing', updatedAt: new Date() }).where(eq(tasks.id, taskId))
  await logRun(taskId, runId, `dispatched to ${plan.agentName} on ${plan.envName}`, { dispatched: true })
  await publishChange('tasks', 'update')

  let buffer = ''
  let lastFlush = 0
  let flushing = false
  const onLine = (line: string) => {
    buffer = tail(`${buffer}${buffer ? '\n' : ''}${line}`)
    const now = Date.now()
    if (now - lastFlush > FLUSH_MS && !flushing) {
      lastFlush = now
      flushing = true
      // flush only while the run row is still 'running': once finish() flips the status,
      // late lines are dropped (their content is already in finish's tail write)
      void db.update(taskRuns).set({ output: tail(buffer) }).where(and(eq(taskRuns.id, runId), eq(taskRuns.status, 'running')))
        .then(() => publishChange('runs', 'update'))
        .finally(() => { flushing = false }) // flush is best-effort; finish() writes the final tail
    }
  }

  const finish = async (status: 'done' | 'failed', exitCode: number | null) => {
    await db.update(taskRuns).set({ status, exitCode, output: tail(buffer), finishedAt: new Date() }).where(eq(taskRuns.id, runId))
    // activity logging must never block the run's verdict (task may be deleted mid-run)
    await logRun(taskId, runId, status === 'done' ? 'run finished' : `run failed (exit ${exitCode ?? '?'})`, { [status]: true, exitCode }).catch(() => {})
    // verdict: done run submits the result for review (or completes when no reviewers)
    if (status === 'done') {
      // routing proposals ([SUBTASKS]/[REASSIGN]) ride the output — record before submit
      try {
        const { parseRoutingProposals } = await import('../../../app/utils/task-thread')
        const payloads = parseRoutingProposals(buffer)
        if (payloads.length) await recordProposals(taskId, runId, payloads)
      } catch { /* proposal recording is best-effort */ }
      const { submitResult } = await import('./workflow.service')
      try {
        await submitResult(taskId, plan.ai.userId, 'run complete')
      } catch { /* task may have moved on; leave as-is */ }
      await db.update(tasks).set({ failStreak: 0, dispatchAfter: null, updatedAt: new Date() }).where(eq(tasks.id, taskId))
    }
    else {
      // bounce to ready, but back off: consecutive failures (and quota walls) must not
      // turn into a 5s retry storm — see BACKOFF_STEPS_MS / QUOTA_PATTERN
      const current = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
      const streak = (current?.failStreak ?? 0) + 1
      const waitMs = backoffFor(streak, buffer)
      await db.update(tasks).set({
        status: 'todo',
        failStreak: streak,
        dispatchAfter: new Date(Date.now() + waitMs),
        updatedAt: new Date(),
      }).where(eq(tasks.id, taskId)) // no-op when the task was deleted mid-run
      await logRun(taskId, runId, `retry scheduled in ${Math.round(waitMs / 60_000)} min (streak ${streak})`, { backoffMs: waitMs }).catch(() => {})
      await publishChange('tasks', 'update')
    }
    await publishChange('runs', 'update')
  }

  const handle: RunHandle = {
    runId,
    finished: new Promise((resolve) => {
      void (async () => {
        try {
          if (process.env.TANDEM_FAKE_RUNNER === '1') {
            const fake = fakeRun(onLine, fakeScriptFromEnv() ?? undefined)
            const r = await fake.finished
            await finish(r.status, r.exitCode)
            resolve(r)
            return
          }
          const envBlob = buildEnvBlob(plan, tandemUrl)
          const briefData = await loadBriefData(taskId)
          const brief = buildBrief(briefData)
          const command = buildCommand(plan, brief)
          const { runOverSsh, loadClient: loadSshClient } = await import('./ssh-exec.util')
          const sshPlan = { env: plan.env, sshKey: plan.sshKey, sshPassword: plan.sshPassword }
          // push input attachments (idempotent; no-op when none)
          await pushInputAttachments(taskId, briefData, sshPlan, plan.envName, loadSshClient, onLine)
          await runOverSsh(plan, command, envBlob, onLine, async (status: 'done' | 'failed', exitCode: number | null) => {
            // settle attachments DETACHED: collection/cleanup must never block the verdict
            void settleAttachments(taskId, runId, sshPlan, status)
            await finish(status, exitCode)
          }, resolve)
        }
        catch (e) {
          /* v8 ignore next -- service throws are Error by construction */
          onLine(`[dispatch] ${e instanceof Error ? e.message : String(e)}`)
          await finish('failed', null)
          resolve({ status: 'failed', exitCode: null })
        }
      })()
    }),
  }
  return handle
}

/** runs for one task, newest first */
export async function listRuns(taskId: string) {
  const rows = await db.select().from(taskRuns).where(eq(taskRuns.taskId, taskId))
  return rows.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
}
