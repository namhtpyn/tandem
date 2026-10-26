import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';
// GET /api/employees/:id/avatar — serve an employee's avatar as a cacheable
// binary image. Avatars are NOT embedded in employees.live (payload bloat);
// rows carry only hasAvatar and the UI points <img src> here. Content is a
// data URL in the DB, unwrapped before responding; only raster image types
// (png/jpeg/webp/gif) are served — svg or anything else 404s — and success
// responses always carry x-content-type-options: nosniff.
// Cache-Control immutable + ETag: uploads replace the image but the ETag
// (updated_at + id hash) changes with it, so browsers revalidate once.
import {
  defineEventHandler,
  createError,
  setResponseHeader,
  getRequestHeader,
  getRequestHeaders,
  setResponseStatus,
  getRouterParam,
} from 'h3';

import { nonNull } from '#shared/utils/non-null';

import { db } from '../../../../db/index';
import { user as userTable } from '../../../../db/schema';

/** only raster types are served; svg+xml and everything else 404s (nosniff below is the belt) */
const AVATAR_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') ?? '';
  // avatars are not secrets, but don't serve them to anonymous crawlers either
  const { buildServerContext } = await import('../../../../domains/kernel/context');
  const headers = new Headers();
  for (const [k, v] of Object.entries(getRequestHeaders(event))) {
    headers.set(k, String(v));
  }
  const session = await buildServerContext(headers).getSession();
  if (!session) throw createError({ statusCode: 401, statusMessage: 'unauthorized' });
  const rows = await db
    .select({ image: userTable.image, updatedAt: userTable.updatedAt })
    .from(userTable)
    .where(eq(userTable.id, id));
  const row = rows[0];
  if (!row?.image) throw createError({ statusCode: 404, statusMessage: 'no avatar' });

  const m = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/s.exec(row.image);
  // serve-edge allowlist: svg (or any non-raster type) 404s and never renders as scriptable markup
  if (!m || !AVATAR_MIME.has(`image/${nonNull(m[1])}`)) throw createError({ statusCode: 404, statusMessage: 'no avatar' });
  const [, mime, b64] = m;
  const body = Buffer.from(nonNull(b64), 'base64');
  const etag = `"${createHash('sha1').update(`${id}:${row.updatedAt.toISOString()}:${body.length}`).digest('hex')}"`;
  setResponseHeader(event, 'x-content-type-options', 'nosniff');
  if (getRequestHeader(event, 'if-none-match') === etag) {
    setResponseStatus(event, 304);
    return '';
  }
  setResponseHeader(event, 'content-type', `image/${mime}`);
  setResponseHeader(event, 'cache-control', 'private, max-age=31536000, immutable');
  setResponseHeader(event, 'etag', etag);
  return body;
});
