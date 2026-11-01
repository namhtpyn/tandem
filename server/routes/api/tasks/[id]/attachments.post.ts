import { and, count, eq } from 'drizzle-orm';
import {
  defineEventHandler,
  createError,
  readMultipartFormData,
  readRawBody,
  getRouterParam,
  getRequestHeaders,
  getRequestHeader,
  setResponseStatus,
} from 'h3';
import { v7 as uuidv7 } from 'uuid';

// POST /api/tasks/:id/attachments — multipart upload of a task input attachment.
// REST exception (like the avatar route): multipart doesn't fit the oRPC proc surface.
// Returns { id, filename, mime, size, sha256 } — the caller embeds
// ![filename](attachment-<id>) / @[filename](attachment-<id>) into the description.
// WRITE-TIER (audit #173): gated like employeeProcedure — anonymous 401,
// rotation-locked 403, VIEWER 403; the body is capped BEFORE multipart parsing
// (declared length rejected pre-read, buffered length before parse) and input
// uploads are quota-bounded per task. The body is consumed ONCE via h3's own
// readRawBody (self-caching, bun-shim-safe) so every rejection is deliverable —
// responding with bytes still in flight resets the socket client-side.
import { nonNull } from '#shared/utils/non-null';

import { db } from '../../../../db/index';
import { taskAttachments } from '../../../../db/schema';
import { buildServerContext } from '../../../../domains/kernel/context';
import {
  assertBodyBytes,
  assertContentLength,
  assertPerTaskQuota,
  gateWriteSession,
  shouldDrainBeforeReject,
  UploadRejection,
} from '../../../../domains/tasks/attachment-upload';
import {
  ATTACHMENT_MAX_BYTES,
  mimeAllowed,
  normalizeMime,
  sanitizeFilename,
  saveAttachmentBytes,
  sha256Hex,
} from '../../../../domains/tasks/attachments.util';

function rethrowAsHttp(err: unknown): never {
  if (err instanceof UploadRejection) throw createError({ statusCode: err.statusCode, statusMessage: err.message });
  throw err;
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') ?? '';
  const contentLength = getRequestHeader(event, 'content-length');

  // declared-oversize bodies: refused before a byte is buffered (a body within
  // the drain ceiling is consumed first so the 413 actually reaches the client)
  try {
    assertContentLength(contentLength);
  } catch (err) {
    if (err instanceof UploadRejection && shouldDrainBeforeReject(contentLength)) await readRawBody(event, false);
    throw err;
  }

  // consume the body ONCE via h3 (cached under the hood — the later
  // readMultipartFormData re-reads this exact buffer) and cap the buffered size
  let raw: Buffer | undefined;
  try {
    raw = (await readRawBody(event, false)) ?? undefined;
    assertBodyBytes(raw);
  } catch (err) {
    rethrowAsHttp(err);
  }

  const headers = new Headers();
  for (const [k, v] of Object.entries(getRequestHeaders(event))) headers.set(k, String(v));
  const session = await buildServerContext(headers).getSession();
  const gate = gateWriteSession(session);
  if (!gate.ok) throw createError({ statusCode: gate.statusCode, statusMessage: gate.statusMessage });
  const user = gate.session.user;

  const task = await db.query.tasks.findFirst({ columns: { id: true }, where: { id: { eq: id } } });
  if (!task) throw createError({ statusCode: 404, statusMessage: 'task not found' });

  const parts = await readMultipartFormData(event);
  const file = parts?.find((p) => p.name === 'file' && p.filename);
  if (!file) throw createError({ statusCode: 422, statusMessage: 'multipart field "file" required' });
  if (file.data.byteLength > ATTACHMENT_MAX_BYTES)
    throw createError({ statusCode: 413, statusMessage: 'attachment too large (20MB max)' });

  const mime = normalizeMime(file.type);
  if (!mimeAllowed(mime)) throw createError({ statusCode: 415, statusMessage: `unsupported type: ${mime}` });

  const [row] = await db
    .select({ n: count() })
    .from(taskAttachments)
    .where(and(eq(taskAttachments.taskId, id), eq(taskAttachments.kind, 'input')));
  try {
    assertPerTaskQuota(Number(row?.n ?? 0));
  } catch (err) {
    rethrowAsHttp(err);
  }

  const filename = sanitizeFilename(nonNull(file.filename));
  const attachmentId = uuidv7();
  await saveAttachmentBytes(id, attachmentId, Buffer.from(file.data));
  const sha = sha256Hex(Buffer.from(file.data));
  await db.insert(taskAttachments).values({
    id: attachmentId,
    taskId: id,
    kind: 'input',
    filename,
    mime,
    size: file.data.byteLength,
    sha256: sha,
    createdBy: user.id,
  });
  setResponseStatus(event, 201);
  return { id: attachmentId, filename, mime, size: file.data.byteLength, sha256: sha };
});
