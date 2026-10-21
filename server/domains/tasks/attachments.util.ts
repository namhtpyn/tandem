// Task attachments: metadata rows in task_attachments, bytes on disk under
// a per-task directory <DATA_ROOT>/tasks/<taskId>/attachments/<id> (DATA_ROOT
// defaults to /tandem — all Tandem data lives under /tandem/**; mount one volume
// there in docker; TANDEM_ATTACHMENTS_DIR overrides the root).
// Two kinds: 'input' (uploaded by a human into the task description) and 'output'
// (collected from the agent sandbox after a run).
// The agent-side staging mirror uses the same per-task shape: ~/.tandem/<taskId>/attachments/.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { env } from '../kernel/env';

/** data root — lazy so setEnv() overrides land without module reloads */
export function dataRoot(): string {
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
export function normalizeMime(raw: string | undefined | null): string {
  const m = (raw || '').toLowerCase().split(';')[0]!.trim();
  return m || 'application/octet-stream';
}

export function mimeAllowed(mime: string): boolean {
  return ATTACHMENT_MIME_ALLOWLIST.has(mime);
}

export function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[/\\]/g, '')
      .replace(/[^\w.\- ]/g, '')
      .trim()
      .slice(0, 120) || 'file'
  );
}

function idSafe(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export function attachmentPath(taskId: string, id: string): string {
  if (!idSafe(taskId)) throw new Error('bad task id');
  if (!idSafe(id)) throw new Error('bad attachment id');
  return join(dataRoot(), 'tasks', taskId, 'attachments', id);
}

export function taskAttachmentsDir(taskId: string): string {
  if (!idSafe(taskId)) throw new Error('bad task id');
  return join(dataRoot(), 'tasks', taskId, 'attachments');
}

export function saveAttachmentBytes(taskId: string, id: string, bytes: Buffer): void {
  mkdirSync(taskAttachmentsDir(taskId), { recursive: true });
  writeFileSync(attachmentPath(taskId, id), bytes);
}

export function readAttachmentBytes(taskId: string, id: string): Buffer {
  return readFileSync(attachmentPath(taskId, id));
}

export function attachmentExists(taskId: string, id: string): boolean {
  return idSafe(taskId) && idSafe(id) && existsSync(attachmentPath(taskId, id));
}

export function deleteAttachmentBytes(taskId: string, id: string): void {
  if (idSafe(taskId) && idSafe(id)) rmSync(attachmentPath(taskId, id), { force: true });
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** attachment tokens in the description markdown, same law as mentions:
 *  ![label](attachment-<id>) for images, @[label](attachment-<id>) for files. */
export function extractAttachmentIds(description: string): string[] {
  const ids = new Set<string>();
  for (const m of description.matchAll(/!\[[^\]]*\]\(attachment-([^)]+)\)/g)) ids.add(m[1]!);
  for (const m of description.matchAll(/@\[[^\]]*\]\(attachment-([^)]+)\)/g)) ids.add(m[1]!);
  return [...ids];
}

/** replace attachment tokens with readable refs for the agent prompt */
export function stripAttachments(desc: string): string {
  return desc
    .replace(/!\[([^\]]*)\]\(attachment-[^)]+\)/g, (_m, label) => `${label}`)
    .replace(/@\[([^\]]*)\]\(attachment-[^)]+\)/g, (_m, label) => `${label}`)
    .trim();
}
