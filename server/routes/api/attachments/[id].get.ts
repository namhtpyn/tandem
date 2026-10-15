// GET /api/attachments/:id — serve an attachment's bytes (authed; session-gated like
// the avatar route, but NO immutable caching: outputs are re-uploaded per run).
import { defineEventHandler, createError, setResponseHeader, getRequestHeader, getRequestHeaders, getRouterParam } from 'h3'
import { eq } from 'drizzle-orm'
import { db } from '../../../db'
import { taskAttachments } from '../../../db/schema'
import { buildServerContext } from '../../../domains/kernel/context'
import { attachmentExists, mimeAllowed, readAttachmentBytes } from '../../../domains/tasks/attachments.util'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') ?? ''
  const headers = new Headers()
  for (const [k, v] of Object.entries(getRequestHeaders(event))) headers.set(k, String(v))
  const session = await buildServerContext(headers).getSession()
  if (!session) throw createError({ statusCode: 401, statusMessage: 'unauthorized' })

  const row = (await db.select().from(taskAttachments).where(eq(taskAttachments.id, id)))[0]
  if (!row) throw createError({ statusCode: 404, statusMessage: 'attachment not found' })
  if (!attachmentExists(row.taskId, id)) throw createError({ statusCode: 410, statusMessage: 'attachment bytes missing' })

  const bytes = readAttachmentBytes(row.taskId, id)
  const mime = mimeAllowed(row.mime) ? row.mime : 'application/octet-stream'
  setResponseHeader(event, 'content-type', mime)
  setResponseHeader(event, 'content-length', bytes.byteLength)
  setResponseHeader(event, 'etag', `"${row.sha256}"`)
  if (getRequestHeader(event, 'if-none-match') === `"${row.sha256}"`) {
    event.node.res.statusCode = 304
    return ''
  }
  setResponseHeader(event, 'content-disposition', `inline; filename="${row.filename.replace(/"/g, '')}"`)
  setResponseHeader(event, 'cache-control', 'private, max-age=60')
  setResponseHeader(event, 'x-content-type-options', 'nosniff')
  return bytes
})
