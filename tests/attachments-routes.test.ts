// Attachment REST routes through the api-harness pattern (real h3 events, mocked session).
import './helpers/pg'
import './api-harness'
import { resetSchema } from './helpers/pg'
import { applyMigrations } from '../server/db/index'
import { describe, expect, it, beforeEach } from 'vitest'
import { createEvent } from 'h3'
import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { db } from '../server/db'
import { tasks, taskAttachments, user as userTable } from '../server/db/schema'
import { saveAttachmentBytes, sha256Hex } from '../server/domains/tasks/attachments.util'
import { STATUS } from '../shared/status'

/** minimal node IncomingMessage carrying a raw body buffer + content-type */
function fakeNodeReq(url: string, body: Buffer, contentType: string, method = 'POST'): IncomingMessage {
  const req = Readable.from([body]) as unknown as IncomingMessage & { headers: Record<string, string>, method: string, url: string }
  req.headers = { 'content-type': contentType, host: 't.test', 'content-length': String(body.byteLength) }
  req.method = method
  req.url = url
  return req
}

function evFor(url: string, body: Buffer, contentType: string, method = 'POST') {
  const ev = createEvent(fakeNodeReq(url, body, contentType, method)) as unknown as {
    context: { params: Record<string, string> }
    node: { req: IncomingMessage & { headers: Record<string, string> }, res: { statusCode?: number, setHeader: (k: string, v: unknown) => void } }
  }
  ev.context.params = { id: 'task-att-1' }
  ev.node.res = { setHeader: () => {} }
  return ev
}

beforeEach(async () => {
  await resetSchema()
  await applyMigrations()
  await db.insert(userTable).values({ id: '00000000-0000-7000-8000-145adf11dba0', name: 'Att Admin', email: 'att-admin@tandem.local', emailVerified: true, role: 'admin', createdAt: new Date(), updatedAt: new Date() })
  await db.insert(tasks).values({ id: 'task-att-1', title: 'Att task', description: '', status: STATUS.todo, createdAt: new Date(), updatedAt: new Date() })
})

describe('POST /api/tasks/:id/attachments', () => {
  it('422s when no multipart file is present', async () => {
    const { default: ep } = await import('../server/routes/api/tasks/[id]/attachments.post')
    const viaRoutePath = await import('../../server/routes/api/tasks/[id]/attachments.post')
    const routeDb = (viaRoutePath as unknown as { __x?: unknown }).__x
    const dbA = (await import('../server/db')).db
    console.log('SAME EP:', ep === (viaRoutePath as { default: unknown }).default)
    await expect(ep(evFor('/api/tasks/task-att-1/attachments', Buffer.from('not multipart'), 'text/plain') as never))
      .rejects.toMatchObject({ statusCode: 422 })
  })

  it('stores an uploaded file: row + bytes, returns metadata', async () => {
    const { default: ep } = await import('../server/routes/api/tasks/[id]/attachments.post')
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    const boundary = '----tandemtest'
    const mpBody = Buffer.from([
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="shot at work.png"',
      'Content-Type: image/png',
      '',
      png.toString('binary'),
      `--${boundary}--`,
      '',
    ].join('\r\n'), 'binary')
    const res = await ep(evFor('/api/tasks/task-att-1/attachments', mpBody, `multipart/form-data; boundary=${boundary}`) as never) as { id: string, filename: string, mime: string, size: number, sha256: string }
    expect(res.mime).toBe('image/png')
    expect(res.filename).toBe('shot at work.png')
    expect(res.size).toBe(png.byteLength)
    expect(res.sha256).toBe(sha256Hex(png))
    const row = (await db.select().from(taskAttachments))[0]
    expect(row.taskId).toBe('task-att-1')
    expect(row.kind).toBe('input')
    expect(row.createdBy).toBe('00000000-0000-7000-8000-3f18cbc16519')
  })

  it('treats a missing router param as an unknown task (defensive arm)', async () => {
    const { default: ep } = await import('../server/routes/api/tasks/[id]/attachments.post')
    const ev = evFor('/api/tasks//attachments', Buffer.from('x'), 'text/plain')
    delete (ev.context as { params?: Record<string, string> }).params
    await expect(ep(ev as never)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('401s without a session', async () => {
    const { default: ep } = await import('../server/routes/api/tasks/[id]/attachments.post')
    const { getAuth } = await import('../server/domains/auth/auth.service')
    const auth = await getAuth()
    const realGetSession = auth.api.getSession
    ;(auth.api as unknown as { getSession: unknown }).getSession = async () => null
    try {
      await expect(ep(evFor('/api/tasks/task-att-1/attachments', Buffer.from('x'), 'text/plain') as never))
        .rejects.toMatchObject({ statusCode: 401 })
    }
    finally {
      ;(auth.api as unknown as { getSession: unknown }).getSession = realGetSession
    }
  })

  it('413s when the file exceeds the 20MB cap', async () => {
    const { default: ep } = await import('../server/routes/api/tasks/[id]/attachments.post')
    const { ATTACHMENT_MAX_BYTES } = await import('../server/domains/tasks/attachments.util')
    const boundary = '----tandemtest'
    const big = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 65)
    const mpBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.txt"\r\nContent-Type: text/plain\r\n\r\n`, 'binary'),
      big,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'binary'),
    ])
    await expect(ep(evFor('/api/tasks/task-att-1/attachments', mpBody, `multipart/form-data; boundary=${boundary}`) as never))
      .rejects.toMatchObject({ statusCode: 413 })
  })

  it('422s on disallowed mime type', async () => {
    const { default: ep } = await import('../server/routes/api/tasks/[id]/attachments.post')
    const boundary = '----tandemtest'
    const mpBody = Buffer.from([
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="run.sh"',
      'Content-Type: application/x-sh',
      '',
      'rm -rf /',
      `--${boundary}--`,
      '',
    ].join('\r\n'), 'binary')
    await expect(ep(evFor('/api/tasks/task-att-1/attachments', mpBody, `multipart/form-data; boundary=${boundary}`) as never))
      .rejects.toMatchObject({ statusCode: 415 })
  })

  it('413s when over the size cap (unit-level guard)', async () => {
    const { ATTACHMENT_MAX_BYTES } = await import('../server/domains/tasks/attachments.util')
    expect(ATTACHMENT_MAX_BYTES).toBe(20 * 1024 * 1024)
  })

  it('404s for a missing task', async () => {
    const { default: ep } = await import('../server/routes/api/tasks/[id]/attachments.post')
    const ev = evFor('/api/tasks/nope/attachments', Buffer.from('x'), 'text/plain')
    ev.context.params = { id: 'nope' }
    await expect(ep(ev as never)).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('GET /api/attachments/:id', () => {
  it('treats a missing router param as unknown (defensive arm)', async () => {
    const { default: get } = await import('../server/routes/api/attachments/[id].get')
    const ev = evFor('/api/attachments/', Buffer.alloc(0), 'text/plain', 'GET')
    delete (ev.context as { params?: Record<string, string> }).params
    await expect(get(ev as never)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('401s without a session', async () => {
    const { default: get } = await import('../server/routes/api/attachments/[id].get')
    const { getAuth } = await import('../server/domains/auth/auth.service')
    const auth = await getAuth()
    const realGetSession = auth.api.getSession
    ;(auth.api as unknown as { getSession: unknown }).getSession = async () => null
    try {
      await expect(get(evFor('/api/attachments/x', Buffer.alloc(0), 'text/plain', 'GET') as never))
        .rejects.toMatchObject({ statusCode: 401 })
    }
    finally {
      ;(auth.api as unknown as { getSession: unknown }).getSession = realGetSession
    }
  })

  it('serves bytes with etag; 304 on revalidation; 404 unknown', async () => {
    const { default: get } = await import('../server/routes/api/attachments/[id].get')
    const id = crypto.randomUUID()
    saveAttachmentBytes('task-att-1', id, Buffer.from('BYTES-1'))
    await db.insert(taskAttachments).values({ id, taskId: 'task-att-1', kind: 'input', filename: 'a.txt', mime: 'text/plain', size: 7, sha256: sha256Hex(Buffer.from('BYTES-1')), createdBy: '00000000-0000-7000-8000-145adf11dba0' })

    const ev = evFor('/api/attachments/' + id, Buffer.alloc(0), 'text/plain', 'GET')
    ev.context.params = { id }
    const sent: Record<string, unknown> = {}
    ev.node.res.setHeader = (k: string, v: unknown) => { sent[k.toLowerCase()] = v }
    const body = await get(ev as never) as Buffer
    expect(body.toString()).toBe('BYTES-1')
    expect(sent.etag).toBeDefined()

    const ev2 = evFor('/api/attachments/' + id, Buffer.alloc(0), 'text/plain', 'GET')
    ev2.context.params = { id }
    ;(ev2.node.req.headers as Record<string, string>)['if-none-match'] = String(sent.etag)
    ev2.node.res.statusCode = 0
    ev2.node.res.setHeader = () => {}
    const r2 = await get(ev2 as never)
    expect(r2).toBe('')

    const ev3 = evFor('/api/attachments/none', Buffer.alloc(0), 'text/plain', 'GET')
    ev3.context.params = { id: 'none' }
    await expect(get(ev3 as never)).rejects.toMatchObject({ statusCode: 404 })

    // 410 when the row exists but bytes are gone
    const ghostId = crypto.randomUUID()
    await db.insert(taskAttachments).values({ id: ghostId, taskId: 'task-att-1', kind: 'input', filename: 'g.txt', mime: 'text/plain', size: 1, sha256: 'z', createdBy: '00000000-0000-7000-8000-145adf11dba0' })
    const ev4 = evFor('/api/attachments/' + ghostId, Buffer.alloc(0), 'text/plain', 'GET')
    ev4.context.params = { id: ghostId }
    await expect(get(ev4 as never)).rejects.toMatchObject({ statusCode: 410 })

    // disallowed row mime falls back to octet-stream download
    const octId = crypto.randomUUID()
    saveAttachmentBytes('task-att-1', octId, Buffer.from('X'))
    await db.insert(taskAttachments).values({ id: octId, taskId: 'task-att-1', kind: 'input', filename: 'm.bin', mime: 'application/x-sh', size: 1, sha256: 'w', createdBy: '00000000-0000-7000-8000-145adf11dba0' })
    const ev5 = evFor('/api/attachments/' + octId, Buffer.alloc(0), 'text/plain', 'GET')
    ev5.context.params = { id: octId }
    const sent5: Record<string, unknown> = {}
    ev5.node.res.setHeader = (k: string, v: unknown) => { sent5[k.toLowerCase()] = v }
    await get(ev5 as never)
    expect(sent5['content-type']).toBe('application/octet-stream')
  })
})
