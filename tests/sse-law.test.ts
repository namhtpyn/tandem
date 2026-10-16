// SSE law (AGENTS.md): initial page-load data comes from conventional GET list
// procs; SSE streams only UPDATE already-loaded pages. This file pins both
// halves: every new `list` GET returns real data, and `changes.live` carries
// change events (not snapshots) for post-load invalidation.
import { beforeEach, describe, expect, it } from 'vitest'
import './api-harness'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '../server/db/index'

async function dbm() {
  return await import('../server/db')
}
async function schema() {
  return await import('../server/db/schema')
}

const admin = { id: 'u-admin', name: 'Admin', email: 'admin@tandem.local', role: 'admin' }

async function ctx(sessionUser: { id: string, name: string, email: string, role: string } | null = admin) {
  const { buildServerContext } = await import('../server/domains/kernel/context')
  const context = buildServerContext(new Headers())
  ;(context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => sessionUser ? { user: sessionUser } : null
  return context
}

async function callProc(path: string, input?: unknown): Promise<any> {
  const { appRouter: router } = await import('../server/domains/app.router')
  let node: Record<string, unknown> = router as unknown as Record<string, unknown>
  for (const key of path.split('.')) {
    node = node[key] as Record<string, unknown>
  }
  const internals = node['~orpc'] as { handler: (opts: unknown) => Promise<unknown> }
  return await internals.handler({ input, context: await ctx(), signal: new AbortController().signal })
}

beforeEach(async () => {
  await resetSchema()
  await applyMigrations()
  const { db } = await dbm()
  const { user } = await schema()
  await db.insert(user).values({ id: 'u-admin', name: 'Admin', email: 'admin@tandem.local', emailVerified: true, role: 'admin', createdAt: new Date(), updatedAt: new Date() })
})

describe('changes.live — the SSE half (post-load events only)', () => {
  it('starts empty (no snapshot) and delivers each published change event', async () => {
    const iter = await callProc('changes.live')
    const nextP = iter.next()
    const winner = await Promise.race([
      nextP.then(() => 'event' as const),
      new Promise(res => setTimeout(() => res('idle' as const), 200)),
    ])
    expect(winner).toBe('idle') // no initial snapshot on the events channel
    const { publishChange } = await import('../server/domains/kernel/kernel')
    await publishChange('tasks', 'create')
    await publishChange('statuses', 'update')
    const e1 = await nextP // resolves on the channel only after a real change
    expect(e1.value).toMatchObject({ resource: 'tasks', action: 'create' })
    const e2 = await iter.next()
    expect(e2.value).toMatchObject({ resource: 'statuses', action: 'update' })
    await iter.return?.()
  })

  it('auth is enforced at the HTTP layer (requireSession), not via handler internals', async () => {
    // callProc invokes `~orpc` handler internals directly, which skips the .use
    // middleware — 401 coverage lives in api-auth.test.ts / rpc-route.test.ts.
    // Pin the shape instead: changes.live is a proc on the protected router.
    const { appRouter } = await import('../server/domains/app.router')
    expect(Object.keys(appRouter)).toContain('changes')
  })
})

describe('conventional GET list procs (the first-load half)', () => {
  it('tasks.list matches tasks.live data shape', async () => {
    const rows = await callProc('tasks.list')
    expect(rows).toEqual([])
    const iter = await callProc('tasks.live')
    const snap = await iter.next()
    await iter.return?.()
    expect(snap.value).toEqual(rows)
  })

  it('tasks.runsList + activityList return rows for a seeded task', async () => {
    const { db } = await dbm()
    const { tasks } = await schema()
    const id = 't-get1'
    await db.insert(tasks).values({ id, title: 'R', description: '', status: 'todo', createdBy: 'u-admin', createdAt: new Date(), updatedAt: new Date() })
    const runs = await callProc('tasks.runsList', { taskId: id })
    expect(runs).toEqual([])
    const acts = await callProc('tasks.activityList', { taskId: id })
    expect(acts).toEqual([])
    const missing = await callProc('tasks.runsList', { taskId: 'does-not-exist' })
    expect(missing).toEqual([])
  })

  it('employees.list returns users + created employees; titles.list counts humans per title', async () => {
    await callProc('employees.titles.save', { name: 'Dev' })
    const emp = await callProc('employees.create', { name: 'Kai', email: 'kai@tandem.local', kind: 'human', title: 'Dev', supervisorIds: [] })
    expect(emp.id).toBeTruthy()
    const rows = await callProc('employees.list')
    expect(rows).toHaveLength(2) // seeded admin user + Kai
    expect(rows.map((r: any) => r.name)).toContain('Kai')
    const titlesList = await callProc('employees.titles.list')
    const titlesLiveIter = await callProc('employees.titles.live')
    const snap = await titlesLiveIter.next()
    await titlesLiveIter.return?.()
    expect(titlesList).toEqual(snap.value) // list == live snapshot (identical plumbing)
    expect(snap.value.titles.find((t: any) => t.name === 'Dev').employees).toBe(1)
  })

  it('project prompt roundtrips through create + update; company prompt persists', async () => {
    const made = await callProc('projects.create', { name: 'P Prompt', description: '', prompt: 'v9 only.' })
    let rows = await callProc('projects.list')
    expect(rows.find((r: any) => r.id === made.id).prompt).toBe('v9 only.')
    await callProc('projects.update', { id: made.id, prompt: 'v10 now.' })
    rows = await callProc('projects.list')
    expect(rows.find((r: any) => r.id === made.id).prompt).toBe('v10 now.')
    await callProc('settings.update', { companyPrompt: 'English only.' })
    const { getCompanyPrompt } = await import('../server/domains/settings/settings.service')
    expect(await getCompanyPrompt()).toBe('English only.')
    await callProc('settings.update', { companyPrompt: '' })
    expect(await getCompanyPrompt()).toBe('')
  })

  it('environments.list, projects.list, statuses.list are plain GETs', async () => {
    expect(await callProc('environments.list')).toEqual([])
    // seed a project so the list mapper (not just the handler) runs
    const p = await callProc('projects.create', { name: 'P Get', description: '' })
    expect(p.id).toBeTruthy()
    const projects = await callProc('projects.list')
    expect(projects).toHaveLength(1)
    expect(projects[0].name).toBe('P Get')
    expect(Array.isArray(await callProc('statuses.list'))).toBe(true)
  })

  it('vault.folders.list maps folder counts both populated and zero; titles.list maps zero-employee titles', async () => {
    const { db } = await dbm()
    const { vaultFolders, vaultSecrets, employeeTitles } = await schema()
    // both shapes: one folder holding a secret count, one empty (??-0 branch)
    await db.insert(vaultFolders).values({ id: 'vf-get1', name: 'Full Folder' })
    await db.insert(vaultFolders).values({ id: 'vf-get2', name: 'Empty Folder' })
    await db.insert(vaultSecrets).values({ id: 'vs-get1', name: 'k', ciphertext: 'v1:c', folderId: 'vf-get1', createdBy: 'u-admin' })
    await db.insert(employeeTitles).values({ id: 'et-get1', name: 'Ghost Title' })
    const folders = await callProc('vault.folders.list')
    expect(folders.folders).toContainEqual(expect.objectContaining({ name: 'Full Folder', secrets: 1 }))
    expect(folders.folders).toContainEqual(expect.objectContaining({ name: 'Empty Folder', secrets: 0 }))
    const titles = await callProc('employees.titles.list')
    expect(titles.titles).toContainEqual(expect.objectContaining({ name: 'Ghost Title', employees: 0 }))
  })

  it('providers.list returns the seeded catalog; settings.list carries app config; oidc.list is empty without providers', async () => {
    const providers = await callProc('providers.list')
    expect(providers.length).toBeGreaterThan(0)
    expect(providers[0]).toHaveProperty('label')
    const settings = await callProc('settings.list')
    expect(settings).toHaveProperty('companyName')
    const oidc = await callProc('oidc.list')
    expect(oidc).toEqual([])
  })

  it('vault.list + vault.folders.list return the GET snapshots', async () => {
    expect(await callProc('vault.list')).toEqual([])
    expect(await callProc('vault.folders.list').then((r: any) => r.folders)).toEqual([])
  })

  it('auth.config is a plain GET (no stream) matching configLive data', async () => {
    const cfg = await callProc('auth.config')
    expect(cfg.passwordEnabled).toBe(true)
    const iter = await callProc('auth.configLive')
    const snap = await iter.next()
    await iter.return?.()
    expect(snap.value).toEqual(cfg)
  })
})
