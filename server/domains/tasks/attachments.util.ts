// Task attachments: metadata rows in tandem_task_attachments, bytes on disk under
// TANDEM_ATTACHMENTS_DIR (default ./data/attachments — a persistent volume in docker).
// Two kinds: 'input' (uploaded by a human into the task description) and 'output'
// (collected from the agent sandbox after a run).
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const ATTACHMENTS_DIR = process.env.TANDEM_ATTACHMENTS_DIR || join(process.cwd(), 'data', 'attachments')

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024 // 20MB per input upload
export const COLLECTION_MAX_BYTES = 50 * 1024 * 1024 // 50MB total collected output per run

export const ATTACHMENT_MIME_ALLOWLIST = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/pdf', 'text/plain', 'text/markdown', 'text/csv',
  'application/json', 'application/zip',
])

/** normalize + allowlist a mime; unknown -> application/octet-stream (rejected by callers) */
export function normalizeMime(raw: string | undefined | null): string {
  const m = (raw || '').toLowerCase().split(';')[0]!.trim()
  return m || 'application/octet-stream'
}

export function mimeAllowed(mime: string): boolean {
  return ATTACHMENT_MIME_ALLOWLIST.has(mime)
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[/\\]/g, '').replace(/[^\w.\- ]/g, '').trim().slice(0, 120) || 'file'
}

function idSafe(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id)
}

export function attachmentPath(id: string): string {
  if (!idSafe(id)) throw new Error('bad attachment id')
  return join(ATTACHMENTS_DIR, id)
}

export function saveAttachmentBytes(id: string, bytes: Buffer): void {
  mkdirSync(ATTACHMENTS_DIR, { recursive: true })
  writeFileSync(attachmentPath(id), bytes)
}

export function readAttachmentBytes(id: string): Buffer {
  return readFileSync(attachmentPath(id))
}

export function attachmentExists(id: string): boolean {
  return idSafe(id) && existsSync(attachmentPath(id))
}

export function deleteAttachmentBytes(id: string): void {
  if (idSafe(id)) rmSync(attachmentPath(id), { force: true })
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** attachment tokens in the description markdown, same law as mentions:
 *  ![label](attachment-<id>) for images, @[label](attachment-<id>) for files. */
export function extractAttachmentIds(description: string): string[] {
  const ids = new Set<string>()
  for (const m of description.matchAll(/!\[[^\]]*\]\(attachment-([^)]+)\)/g)) ids.add(m[1]!)
  for (const m of description.matchAll(/@\[[^\]]*\]\(attachment-([^)]+)\)/g)) ids.add(m[1]!)
  return [...ids]
}

/** replace attachment tokens with readable refs for the agent prompt */
export function stripAttachments(desc: string): string {
  return desc
    .replace(/!\[([^\]]*)\]\(attachment-[^)]+\)/g, (_m, label) => `${label}`)
    .replace(/@\[([^\]]*)\]\(attachment-[^)]+\)/g, (_m, label) => `${label}`)
    .trim()
}
