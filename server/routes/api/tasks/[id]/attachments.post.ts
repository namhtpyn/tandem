// POST /api/tasks/:id/attachments — multipart upload of a task input attachment.
// REST exception (like the avatar route): multipart doesn't fit the oRPC proc surface.
// Returns { id, filename, mime, size, sha256 } — the caller embeds
// ![filename](attachment-<id>) / @[filename](attachment-<id>) into the description.
import { defineEventHandler, createError, readMultipartFormData, getRouterParam, getRequestHeaders, setResponseStatus } from 'h3'
import { and, eq } from 'drizzle-orm'
import { db } from '../../../../db'
import { tasks, taskAttachments } from '../../../../db/schema'
import { buildServerContext } from '../../../../domains/kernel/context'
import {
  ATTACHMENT_MAX_BYTES, mimeAllowed, normalizeMime, sanitizeFilename,
  saveAttachmentBytes, sha256Hex,
} from '../../../../domains/tasks/attachments.util'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') ?? ''
  const headers = new Headers()
  for (const [k, v] of Object.entries(getRequestHeaders(event))) headers.set(k, String(v))
  const session = await buildServerContext(headers).getSession()
  if (!session) throw createError({ statusCode: 401, statusMessage: 'unauthorized' })

  const task = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)))[0]
  if (!task) throw createError({ statusCode: 404, statusMessage: 'task not found' })

  const parts = await readMultipartFormData(event)
  const file = parts?.find(p => p.name === 'file' && p.filename)
  if (!file) throw createError({ statusCode: 422, statusMessage: 'multipart field "file" required' })
  if (file.data.byteLength > ATTACHMENT_MAX_BYTES) throw createError({ statusCode: 413, statusMessage: 'attachment too large (20MB max)' })

  const mime = normalizeMime(file.type)
  if (!mimeAllowed(mime)) throw createError({ statusCode: 415, statusMessage: `unsupported type: ${mime}` })

  const filename = sanitizeFilename(file.filename || '')
  const attachmentId = crypto.randomUUID()
  saveAttachmentBytes(attachmentId, Buffer.from(file.data))
  const sha = sha256Hex(Buffer.from(file.data))
  await db.insert(taskAttachments).values({
    id: attachmentId,
    taskId: id,
    kind: 'input',
    filename,
    mime,
    size: file.data.byteLength,
    sha256: sha,
    createdBy: session.user.id,
  })
  setResponseStatus(event, 201)
  return { id: attachmentId, filename, mime, size: file.data.byteLength, sha256: sha }
})
