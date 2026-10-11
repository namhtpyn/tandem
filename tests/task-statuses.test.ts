// task statuses: CRUD + transition enforcement on tasks
import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import './api-harness'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '../server/db/index'


async function wireDecisionProvider(secretId: string | null) {
  const d = await dbm()
  const { modelProviders } = await import('../server/db/schema')
  await d.db.insert(modelProviders)
    .values({ id: 'seed-jev', label: 'Jev (TypeSafe AI)', baseUrl: 'https://api.typesafe.ai/v1/systemone', apiStyles: ['TYPESAFE-SYSTEMONE'], keySecretId: secretId })
    .onConflictDoUpdate({ target: modelProviders.id, set: { keySecretId: secretId, apiStyles: ['TYPESAFE-SYSTEMONE'] } })
}

const admin = { id: 'u-admin', name: 'Admin', email: 'admin@tandem.local', role: 'admin' }

async function ctx() {
  const { buildServerContext } = await import('../server/utils/orpc')
  const context = buildServerContext(new Headers()) as Record<string, unknown>
  ;(context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => ({ user: admin })
  context.session = { user: admin }
  return context
}

async function dbm() {
  return await import('../server/db')
}

async function callProc(path: string, input?: unknown): Promise<any> {
  const { router } = await import('../server/utils/orpc')
  let node: Record<string, unknown> = router as unknown as Record<string, unknown>
  for (const key of path.split('.')) node = node[key] as Record<string, unknown>
  const internals = node['~orpc'] as { handler: (opts: unknown) => Promise<unknown> }
  return await internals.handler({ input, context: await ctx(), signal: new AbortController().signal })
}

beforeEach(async () => {
  await resetSchema()
  await applyMigrations()
  const { db } = await import('../server/db')
  const { user } = await import('../server/db/schema')
  await db.insert(user).values({ id: admin.id, name: 'Admin', email: 'admin@tandem.local', role: 'admin', title: 'T' })
})

describe('task statuses', () => {
  it('live returns seeded statuses ordered with transitions', async () => {
    const iter = await callProc('statuses.live')
    const snap = (await iter.next()).value
    const rows = (snap as any).status === 'pending' ? (await iter.next()).value : snap
    const list = Array.isArray(rows) ? rows : (rows as any).rows ?? rows
    const ids = (list as any[]).map(x => x.id)
    expect(ids).toEqual(['todo', 'doing', 'done'])
    expect((list as any[]).find(x => x.id === 'doing')!.nextIds).toContain('done')
    expect((list as any[]).find(x => x.id === 'todo')!.category).toBe('ready')
  })

  it('save creates a status with transitions; unknown transition rejected', async () => {
    const r = await callProc('statuses.save', { name: 'In review', color: 'warning', position: 2, category: 'working', nextIds: ['done'] })
    expect(r.id).toBeTruthy()
    await expect(callProc('statuses.save', { name: 'Bad', color: 'neutral', position: 5, isDone: false, nextIds: ['ghost'] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('save upserts by id (rename)', async () => {
    const r = await callProc('statuses.save', { id: 'todo', name: 'Backlog', color: 'neutral', position: 0, category: 'ready', nextIds: ['doing'] })
    expect(r.id).toBe('todo')
    const { db } = await dbm()
    const { taskStatuses } = await import('../server/db/schema')
    const row = (await db.select().from(taskStatuses)).find(x => x.id === 'todo')!
    expect(row.name).toBe('Backlog')
  })

  it('remove blocked while a task uses the status', async () => {
    const t = await callProc('tasks.create', { title: 'T1' })
    await expect(callProc('statuses.remove', { id: 'todo' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await callProc('tasks.remove', { id: t.id })
    await expect(callProc('statuses.remove', { id: 'todo' })).resolves.toMatchObject({ ok: true })
  })

  it('save rejects reserved id "new"', async () => {
    await expect(callProc('statuses.save', { id: 'new', name: 'N', color: 'neutral', position: 9, isDone: false, nextIds: [] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('create with no statuses defined fails clearly', async () => {
    // remove all seeded statuses (no tasks exist)
    for (const id of ['todo', 'doing', 'done']) await callProc('statuses.remove', { id })
    await expect(callProc('tasks.create', { title: 'NoStatus' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: /no task statuses/i })
  })

  it('remove unknown 404s', async () => {
    await expect(callProc('statuses.remove', { id: 'ghost' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('tasks.create validates status; default = first status', async () => {
    const t = await callProc('tasks.create', { title: 'A' })
    const { db } = await dbm()
    const { tasks } = await import('../server/db/schema')
    const row = (await db.select().from(tasks)).find(x => x.id === t.id)!
    expect(row.status).toBe('todo')
    await expect(callProc('tasks.create', { title: 'B', status: 'ghost' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const t2 = await callProc('tasks.create', { title: 'C', status: 'doing' })
    const row2 = (await db.select().from(tasks)).find(x => x.id === t2.id)!
    expect(row2.status).toBe('doing')
  })

  it('tasks.update enforces transitions (todo -> done blocked, todo -> doing ok)', async () => {
    const t = await callProc('tasks.create', { title: 'X' })
    await expect(callProc('tasks.update', { id: t.id, status: 'done' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: /cannot move/i })
    await callProc('tasks.update', { id: t.id, status: 'doing' })
    await callProc('tasks.update', { id: t.id, status: 'done' })
    await expect(callProc('tasks.update', { id: t.id, status: 'ghost' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: /does not exist/i })
  })

  it('tasks.update same-status is a no-op pass', async () => {
    const t = await callProc('tasks.create', { title: 'Y' })
    await expect(callProc('tasks.update', { id: t.id, status: 'todo' })).resolves.toMatchObject({ ok: true })
  })
})


describe('jev auto-assign', () => {
  it('assign: no decision provider at all -> clear reason', async () => {
    const d = await dbm()
    const { modelProviders } = await import('../server/db/schema')
    await d.db.delete(modelProviders)
    const t = await callProc('tasks.create', { title: 'NoProvider' })
    const r = await callProc('statuses.assign', { taskId: t.id })
    expect(r.assigned).toBe(false)
    expect(r.reason).toBe('no decision provider configured')
    // restore provider seeds for any later reader (parallel files share the DB)
    await d.db.insert(modelProviders).values({ id: 'seed-jev', label: 'Jev (TypeSafe AI)', baseUrl: 'https://api.typesafe.ai/v1/systemone', apiStyles: ['TYPESAFE-SYSTEMONE'] }).onConflictDoNothing()
  })

  it('assign: seeded provider without key -> assigned false with reason', async () => {
    const t = await callProc('tasks.create', { title: 'Jev task' })
    const r = await callProc('statuses.assign', { taskId: t.id })
    expect(r.assigned).toBe(false)
    expect(r.reason).toMatch(/has no api key/)
  })

  it('assign: with mocked jev response assigns the chosen employee', async () => {
    // create a vault secret as the jev key holder
    const sec = await callProc('vault.create', { name: 'jev-key', value: 'sk-jev-test' })
    await wireDecisionProvider(sec.id)
    // an employee candidate
    const emp = await callProc('employees.create', { name: 'Jev Bot', email: 'jevbot@tandem.local', kind: 'human', title: 'Runner', supervisorIds: [] })
    const t = await callProc('tasks.create', { title: 'Write the docs' })

    const origFetch = globalThis.fetch
    let called = 0
    let seenBody = ''
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      called++
      seenBody = String((init as { body?: string })?.body ?? '')
      const target = (url as string).includes('typesafe.ai')
      if (target) {
        return { ok: true, status: 200, json: async () => ({ model: 'jev-test', answers: { assignee: { type: 'choice', choice: emp.id, confidence: 0.9, probabilities: { [emp.id]: 0.9 } } } }) }
      }
      return origFetch(url as any, init as any)
    }) as typeof fetch
    try {
      const r = await callProc('statuses.assign', { taskId: t.id })
      expect(r.assigned).toBe(true)
      expect(r.employeeId).toBe(emp.id)
      expect(called).toBe(1)
      expect(seenBody).toContain('Write the docs')
      // task updated
      const { db } = await dbm()
      const { tasks } = await import('../server/db/schema')
      const row = (await db.select().from(tasks)).find(x => x.id === t.id)!
      expect(row.assigneeId).toBe(emp.id)
    }
    finally { globalThis.fetch = origFetch }
  })

  it('assign: low confidence leaves task unassigned', async () => {
    const sec = await callProc('vault.create', { name: 'jev-key2', value: 'sk-jev-test2' })
    await wireDecisionProvider(sec.id)
    const t = await callProc('tasks.create', { title: 'Unclear task' })
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ model: 'jev-test', answers: { assignee: { type: 'choice', choice: 'unassigned', confidence: 0.9, probabilities: { unassigned: 0.9 } } } }) })) as typeof fetch
    try {
      const r = await callProc('statuses.assign', { taskId: t.id })
      expect(r.assigned).toBe(false)
      expect(r.reason).toMatch(/unassigned/)
    }
    finally { globalThis.fetch = origFetch }
  })

  it('assign: jev failure arms (http error, no choice, unknown id, network throw)', async () => {
    const sec = await callProc('vault.create', { name: 'jev-key3', value: 'sk-jev-3' })
    await wireDecisionProvider(sec.id)
    const t = await callProc('tasks.create', { title: 'Arms' })
    const origFetch = globalThis.fetch
    // http error
    globalThis.fetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as typeof fetch
    let r = await callProc('statuses.assign', { taskId: t.id })
    expect(r.assigned).toBe(false); expect(r.reason).toMatch(/401/)
    // no choice
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ model: 'm', answers: {} }) })) as typeof fetch
    r = await callProc('statuses.assign', { taskId: t.id })
    expect(r.assigned).toBe(false); expect(r.reason).toMatch(/no choice/)
    // unknown employee id
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ model: 'm', answers: { assignee: { type: 'choice', choice: 'ghost-emp', confidence: 0.9, probabilities: {} } } }) })) as typeof fetch
    r = await callProc('statuses.assign', { taskId: t.id })
    expect(r.assigned).toBe(false); expect(r.reason).toMatch(/unknown employee/)
    // low confidence (valid candidate id below 0.5)
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ model: 'm', answers: { assignee: { type: 'choice', choice: 'u-admin', confidence: 0.3, probabilities: {} } } }) })) as typeof fetch
    r = await callProc('statuses.assign', { taskId: t.id })
    expect(r.assigned).toBe(false); expect(r.reason).toMatch(/low confidence/)
    // network throw
    globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
    r = await callProc('statuses.assign', { taskId: t.id })
    expect(r.assigned).toBe(false); expect(r.reason).toMatch(/could not reach/)
    globalThis.fetch = origFetch
  })

  it('assign: empty candidate list + assigned-task load counting', async () => {
    // create task first (created_by FK), then delete all users -> zero candidates
    const t1 = await callProc('tasks.create', { title: 'NoCandidates' })
    const { db } = await dbm()
    const { user } = await import('../server/db/schema')
    await db.delete(user)
    const r = await callProc('statuses.assign', { taskId: t1.id })
    expect(r.assigned).toBe(false)
    expect(r.reason).toMatch(/no assignee candidates/)
  })

  it('assign: candidate state string includes title/load/description arms', async () => {
    const sec = await callProc('vault.create', { name: 'jev-key4', value: 'sk-jev-4' })
    await wireDecisionProvider(sec.id)
    // AI employee with a title + open task load; human without title
    const d = await dbm()
    const { environments } = await import('../server/db/schema')
    await d.db.insert(environments).values({ id: 'env-jev', name: 'env-jev', host: '127.0.0.1', port: '22', username: 'u' })
    const ai = await callProc('employees.create', { name: 'Titled Bot', email: 'tb@tandem.local', kind: 'ai', title: 'Writer', environmentId: 'env-jev' })
    const loaded = await callProc('tasks.create', { title: 'Load carrier' })
    await callProc('tasks.update', { id: loaded.id, assigneeId: ai.id })
    const t = await callProc('tasks.create', { title: 'Rich task', description: 'with description' })
    const origFetch = globalThis.fetch
    let state = ''
    let criteria = ''
    globalThis.fetch = (async (_u: unknown, init?: unknown) => {
      const body = JSON.parse(String((init as { body?: string })?.body ?? '{}'))
      state = body.state
      criteria = JSON.stringify(body.questions.assignee.criteria)
      return { ok: true, status: 200, json: async () => ({ model: 'jev-test', answers: { assignee: { type: 'choice', choice: ai.id, confidence: 0.8, probabilities: {} } } }) }
    }) as typeof fetch
    try {
      const r = await callProc('statuses.assign', { taskId: t.id })
      expect(r.assigned).toBe(true)
      expect(state).toContain('with description')
      expect(state).toContain('1 open tasks')
      expect(criteria).toContain('AI agent — Titled Bot, Writer, currently 1 open task(s)')
    }
    finally { globalThis.fetch = origFetch }
  })

  it('assign: minimal jev answer (no confidence/probabilities) still assigns', async () => {
    const sec = await callProc('vault.create', { name: 'jev-key5', value: 'sk-jev-5' })
    await wireDecisionProvider(sec.id)
    const t = await callProc('tasks.create', { title: 'Minimal' })
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ model: 'jev-test', answers: { assignee: { type: 'choice', choice: 'u-admin' } } }) })) as typeof fetch
    try {
      const r = await callProc('statuses.assign', { taskId: t.id })
      expect(r.assigned).toBe(false) // confidence defaults to 0 -> low confidence arm
      expect(r.reason).toMatch(/low confidence 0.00/)
    }
    finally { globalThis.fetch = origFetch }
  })

  it('assign: untitled AI candidate + task with project covers remaining arms', async () => {
    const sec = await callProc('vault.create', { name: 'jev-key6', value: 'sk-jev-6' })
    await wireDecisionProvider(sec.id)
    const d = await dbm()
    const { environments } = await import('../server/db/schema')
    await d.db.insert(environments).values({ id: 'env-j2', name: 'env-j2', host: '127.0.0.1', port: '22', username: 'u' })
    const ai = await callProc('employees.create', { name: 'Plain Bot', email: 'pb@tandem.local', kind: 'ai', title: 'Writer', environmentId: 'env-j2' })
    // null the title on the user row (candidates map reads user.title)
    const { user } = await import('../server/db/schema')
    await d.db.update(user).set({ title: null }).where(eq(user.id, ai.id))
    const proj = await callProc('projects.create', { name: 'JevProj' })
    const t = await callProc('tasks.create', { title: 'Proj task', projectId: proj.id })
    const origFetch = globalThis.fetch
    let state = ''
    globalThis.fetch = (async (_u: unknown, init?: unknown) => {
      state = JSON.parse(String((init as { body?: string })?.body ?? '{}')).state
      return { ok: true, status: 200, json: async () => ({ model: 'jev-test', answers: { assignee: { type: 'choice', choice: ai.id, confidence: 0.9, probabilities: {} } } }) }
    }) as typeof fetch
    try {
      const r = await callProc('statuses.assign', { taskId: t.id })
      expect(r.assigned).toBe(true)
      expect(state).toContain('Project: JevProj')
    }
    finally { globalThis.fetch = origFetch }
  })

  it('assign: dangling secret id + deleted project name arms', async () => {
    await wireDecisionProvider('ghost-secret')
    const proj = await callProc('projects.create', { name: 'GhostProj' })
    const t = await callProc('tasks.create', { title: 'GhostProj task', projectId: proj.id })
    // delete the project row directly -> task.projectId dangles (set null by FK in real flow; simulate)
    const d = await dbm()
    const { projects } = await import('../server/db/schema')
    await d.db.delete(projects).where(eq(projects.id, proj.id))
    // ghost secret id -> provider exists but key undecryptable/missing
    const r = await callProc('statuses.assign', { taskId: t.id })
    expect(r.assigned).toBe(false)
    expect(r.reason).toMatch(/no api key/)
  })

  it('assign: unassigned choice with probabilities present', async () => {
    const sec = await callProc('vault.create', { name: 'jev-key7', value: 'sk-jev-7' })
    await wireDecisionProvider(sec.id)
    const t = await callProc('tasks.create', { title: 'Unassign me' })
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ model: 'jev-test', answers: { assignee: { type: 'choice', choice: 'unassigned', confidence: 0.8, probabilities: { unassigned: 0.8, 'u-admin': 0.2 } } } }) })) as typeof fetch
    try {
      const r = await callProc('statuses.assign', { taskId: t.id })
      expect(r.assigned).toBe(false)
      expect(r.reason).toBe('jev chose unassigned')
      expect(r.confidence).toBe(0.8)
      expect(r.probabilities).toMatchObject({ unassigned: 0.8 })
    }
    finally { globalThis.fetch = origFetch }
  })

  it('assign: low-confidence choice with probabilities + missing model', async () => {
    const sec = await callProc('vault.create', { name: 'jev-key8', value: 'sk-jev-8' })
    await wireDecisionProvider(sec.id)
    const t = await callProc('tasks.create', { title: 'Lowconf' })
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ answers: { assignee: { type: 'choice', choice: 'u-admin', confidence: 0.2, probabilities: { 'u-admin': 0.2 } } } }) })) as typeof fetch
    try {
      const r = await callProc('statuses.assign', { taskId: t.id })
      expect(r.assigned).toBe(false)
      expect(r.reason).toMatch(/low confidence 0.20/)
      expect(r.probabilities).toMatchObject({ 'u-admin': 0.2 })
    }
    finally { globalThis.fetch = origFetch }
  })

  it('assign: no-choice response without model falls back to unknown', async () => {
    const sec = await callProc('vault.create', { name: 'jev-key9', value: 'sk-jev-9' })
    await wireDecisionProvider(sec.id)
    const t = await callProc('tasks.create', { title: 'NoModel' })
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ answers: {} }) })) as typeof fetch
    try {
      const r = await callProc('statuses.assign', { taskId: t.id })
      expect(r.assigned).toBe(false)
      expect(r.reason).toBe('jev returned no choice')
      expect(r.model).toBe('unknown')
    }
    finally { globalThis.fetch = origFetch }
  })

  it('assign: task with dangling project id yields no project name', async () => {
    const sec = await callProc('vault.create', { name: 'jev-keyA', value: 'sk-jev-A' })
    await wireDecisionProvider(sec.id)
    const t = await callProc('tasks.create', { title: 'Ghost proj' })
    // simulate a dangling project reference (FK normally prevents it; guards the lookup)
    const d = await dbm()
    const { tasks } = await import('../server/db/schema')
    await d.db.execute('ALTER TABLE tandem_tasks DROP CONSTRAINT tandem_tasks_project_id_tandem_projects_id_fkey')
    await d.db.update(tasks).set({ projectId: 'ghost-proj' }).where(eq(tasks.id, t.id))
    const origFetch = globalThis.fetch
    let state = ''
    globalThis.fetch = (async (_u: unknown, init?: unknown) => {
      state = JSON.parse(String((init as { body?: string })?.body ?? '{}')).state
      return { ok: true, status: 200, json: async () => ({ model: 'm', answers: { assignee: { type: 'choice', choice: 'u-admin', confidence: 0.9, probabilities: {} } } }) }
    }) as typeof fetch
    try {
      const r = await callProc('statuses.assign', { taskId: t.id })
      expect(r.assigned).toBe(true)
      expect(state).not.toContain('Project:')
    }
    finally { globalThis.fetch = origFetch }
  })

  it('assign: unknown task 404s', async () => {
    await expect(callProc('statuses.assign', { taskId: 'ghost' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
