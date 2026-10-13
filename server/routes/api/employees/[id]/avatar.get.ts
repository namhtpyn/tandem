// GET /api/employees/:id/avatar — serve an employee's avatar as a cacheable
// binary image. Avatars are NOT embedded in employees.live (payload bloat);
// rows carry only hasAvatar and the UI points <img src> here. Content is a
// data URL in the DB (image/jpeg base64), unwrapped before responding.
// Cache-Control immutable + ETag: uploads replace the image but the ETag
// (updated_at + id hash) changes with it, so browsers revalidate once.
import { defineEventHandler, createError, setResponseHeader, getRequestHeader, getRequestHeaders, setResponseStatus, getRouterParam } from 'h3'
import { eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { db } from '../../../../db'
import { user as userTable } from '../../../../db/schema'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') ?? ''
  // avatars are not secrets, but don't serve them to anonymous crawlers either
  const { buildServerContext } = await import('../../../../domains/kernel/context')
  const headers = new Headers()
  for (const [k, v] of Object.entries(getRequestHeaders(event))) {
    headers.set(k, String(v))
  }
  const session = await buildServerContext(headers).getSession()
  if (!session) throw createError({ statusCode: 401, statusMessage: 'unauthorized' })
  const rows = await db.select({ image: userTable.image, updatedAt: userTable.updatedAt })
    .from(userTable).where(eq(userTable.id, id))
  const row = rows[0]
  if (!row?.image) throw createError({ statusCode: 404, statusMessage: 'no avatar' })

  const m = /^data:image\/([a-z+]+);base64,(.+)$/s.exec(row.image)
  if (!m) throw createError({ statusCode: 422, statusMessage: 'avatar not a data url' })
  const [, mime, b64] = m
  const body = Buffer.from(b64!, 'base64')
  const etag = `"${createHash('sha1').update(`${id}:${row.updatedAt.toISOString()}:${body.length}`).digest('hex')}"`
  if (getRequestHeader(event, 'if-none-match') === etag) {
    setResponseStatus(event, 304)
    return ''
  }
  setResponseHeader(event, 'content-type', `image/${mime}`)
  setResponseHeader(event, 'cache-control', 'private, max-age=31536000, immutable')
  setResponseHeader(event, 'etag', etag)
  return body
})
