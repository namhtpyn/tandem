// Suite-scoped test Postgres. Runs ONCE in the main vitest process (not per
// worker): starts/reuses a dedicated container, hands every worker its URL via
// `provide`, and tears it down when the WHOLE suite finishes.
// CI: a postgres service container already exists (TANDEM_TEST_DATABASE_URL),
// so this is a pass-through. The dev container (tandem-pg) is never touched.
import type { GlobalSetupContext } from 'vitest/node'
import { execSync } from 'node:child_process'

const NAME = 'tandem-test-pg'
const needsLocalContainer =
  !process.env.TANDEM_TEST_DATABASE_URL && !process.env.CI

function run(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
}

function containerRunning(): boolean {
  try {
    return run(`docker inspect -f {{.State.Running}} ${NAME}`) === 'true'
  } catch {
    return false
  }
}

async function waitForReadiness(): Promise<void> {
  // pg_isready rc=0 during init even though logins are rejected — probe a
  // real authenticated query through the mapped port instead.
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      run(`docker exec ${NAME} psql -U tandem -d tandem_test -c 'select 1'`)
      return
    } catch {
      if (Date.now() > deadline) throw new Error('tandem-test-pg did not accept logins in 30s')
      await new Promise(r => setTimeout(r, 250))
    }
  }
}

async function discoverPort(): Promise<string> {
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const port = run(`docker port ${NAME} 5432/tcp`).split('\n')[0]!.split(':').pop()!.trim()
      if (port) return port
    } catch { /* container still creating */ }
    if (Date.now() > deadline) throw new Error('tandem-test-pg never exposed a port')
    await new Promise(r => setTimeout(r, 250))
  }
}

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  if (!needsLocalContainer) {
    const url = process.env.TANDEM_TEST_DATABASE_URL
      || 'postgresql://tandem:tandem@127.0.0.1:5432/tandem_test'
    process.env.TANDEM_TEST_DATABASE_URL = url
    provide('testDatabaseUrl', url)
    return
  }

  // Reuse a healthy leftover from a crashed run; otherwise (re)create.
  if (!containerRunning()) {
    try { run(`docker rm -f ${NAME}`) } catch { /* none */ }
    const port = String(39000 + Math.floor(Math.random() * 1000))
    run(`docker run -d --rm --name ${NAME} -e POSTGRES_USER=tandem -e POSTGRES_PASSWORD=tandem -e POSTGRES_DB=tandem_test -p ${port}:5432 postgres:17-alpine`)
  }
  await waitForReadiness()
  const port = await discoverPort()
  const url = `postgresql://tandem:tandem@127.0.0.1:${port}/tandem_test`
  process.env.TANDEM_TEST_DATABASE_URL = url
  provide('testDatabaseUrl', url)
}

export async function teardown(): Promise<void> {
  if (!needsLocalContainer) return
  try { run(`docker rm -f ${NAME}`) } catch { /* already gone */ }
}
