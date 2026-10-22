import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

// Task attachments: metadata rows in task_attachments, bytes on disk under
// a per-task directory <DATA_ROOT>/tasks/<taskId>/attachments/<id> (DATA_ROOT
// defaults to /tandem — all Tandem data lives under /tandem/**; mount one volume
// there in docker; TANDEM_ATTACHMENTS_DIR overrides the root).
// Two kinds: 'input' (uploaded by a human into the task description) and 'output'
// (collected from the agent sandbox after a run).
// The agent-side staging mirror uses the same per-task shape: ~/.tandem/<taskId>/attachments/.
import { nonNull } from '#shared/utils/non-null';

import { env } from '../kernel/env';

/** data root — lazy so setEnv() overrides land without module reloads */
export function dataRoot() {
  return env.TANDEM_ATTACHMENTS_DIR || '/tandem';
}

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024; // 20MB per input upload
export const COLLECTION_MAX_BYTES = 50 * 1024 * 1024; // 50MB total collected output per run

export const ATTACHMENT_MIME_ALLOWLIST = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/zip',
]);

/** normalize + allowlist a mime; unknown -> application/octet-stream (rejected by callers) */
export function normalizeMime(raw: string | undefined | null) {
  const m = nonNull((raw || '').toLowerCase().split(';')[0]).trim();
  return m || 'application/octet-stream';
}

export function mimeAllowed(mime: string) {
  return ATTACHMENT_MIME_ALLOWLIST.has(mime);
}

export function sanitizeFilename(name: string) {
  return (
    name
      .replace(/[/\\]/g, '')
      .replace(/[^\w.\- ]/g, '')
      .trim()
      .slice(0, 120) || 'file'
  );
}

function idSafe(id: string) {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export function attachmentPath(taskId: string, id: string) {
  if (!idSafe(taskId)) throw new Error('bad task id');
  if (!idSafe(id)) throw new Error('bad attachment id');
  return path.join(dataRoot(), 'tasks', taskId, 'attachments', id);
}

export function taskAttachmentsDir(taskId: string) {
  if (!idSafe(taskId)) throw new Error('bad task id');
  return path.join(dataRoot(), 'tasks', taskId, 'attachments');
}

export async function saveAttachmentBytes(taskId: string, id: string, bytes: Buffer | Uint8Array) {
  await mkdir(taskAttachmentsDir(taskId), { recursive: true });
  await Bun.write(attachmentPath(taskId, id), bytes);
}

export async function readAttachmentBytes(taskId: string, id: string): Promise<Buffer> {
  return Buffer.from(await Bun.file(attachmentPath(taskId, id)).arrayBuffer());
}

export async function attachmentExists(taskId: string, id: string) {
  return idSafe(taskId) && idSafe(id) && (await Bun.file(attachmentPath(taskId, id)).exists());
}

export async function deleteAttachmentBytes(taskId: string, id: string) {
  if (idSafe(taskId) && idSafe(id)) await rm(attachmentPath(taskId, id), { force: true });
}

export function sha256Hex(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** attachment tokens in the description markdown, same law as mentions:
 *  ![label](attachment-<id>) for images, @[label](attachment-<id>) for files. */
export function extractAttachmentIds(description: string) {
  const ids = new Set<string>();
  for (const m of description.matchAll(/!\[[^\]]*\]\(attachment-([^)]+)\)/g)) ids.add(nonNull(m[1]));
  for (const m of description.matchAll(/@\[[^\]]*\]\(attachment-([^)]+)\)/g)) ids.add(nonNull(m[1]));
  return [...ids];
}

/** replace attachment tokens with readable refs for the agent prompt */
export function stripAttachments(desc: string) {
  return desc
    .replace(/!\[([^\]]*)\]\(attachment-[^)]+\)/g, (_m, label) => `${label}`)
    .replace(/@\[([^\]]*)\]\(attachment-[^)]+\)/g, (_m, label) => `${label}`)
    .trim();
}
