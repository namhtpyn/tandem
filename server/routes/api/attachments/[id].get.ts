import { eq } from 'drizzle-orm';
// GET /api/attachments/:id — serve an attachment's bytes (authed; session-gated like
// the avatar route, but NO immutable caching: outputs are re-uploaded per run).
import { defineEventHandler, createError, getRequestHeader, getRequestHeaders, getRouterParam } from 'h3';

import { db } from '../../../db';
import { taskAttachments } from '../../../db/schema';
import { buildServerContext } from '../../../domains/kernel/context';
import { attachmentPath, mimeAllowed } from '../../../domains/tasks/attachments.util';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') ?? '';
  const headers = new Headers();
  for (const [k, v] of Object.entries(getRequestHeaders(event))) headers.set(k, String(v));
  const session = await buildServerContext(headers).getSession();
  if (!session) throw createError({ statusCode: 401, statusMessage: 'unauthorized' });

  const row = await db.query.taskAttachments.findFirst({ where: { id: { eq: id } } });
  if (!row) throw createError({ statusCode: 404, statusMessage: 'attachment not found' });
  // stream straight off disk (Bun.file = zero-copy sendfile); no buffer read
  const file = Bun.file(attachmentPath(row.taskId, id));
  if (!(await file.exists())) throw createError({ statusCode: 410, statusMessage: 'attachment bytes missing' });

  const mime = mimeAllowed(row.mime) ? row.mime : 'application/octet-stream';
  const etag = `"${row.sha256}"`;
  if (getRequestHeader(event, 'if-none-match') === etag) {
    event.node.res.statusCode = 304;
    return '';
  }
  return new Response(file, {
    headers: {
      'content-type': mime,
      'content-length': String(file.size),
      etag,
      'content-disposition': `inline; filename="${row.filename.replace(/"/g, '')}"`,
      'cache-control': 'private, max-age=60',
      'x-content-type-options': 'nosniff',
    },
  });
});
