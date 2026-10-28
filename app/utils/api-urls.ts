// REST URL builders — the only REST surfaces beside /auth and /health. One
// construction site each so a route rename can't strand string copies.

/** employee avatar endpoint (keyed by the USER id) */
export function employeeAvatarUrl(userId: string): string {
  return `/api/employees/${userId}/avatar`;
}

/** uploaded attachment bytes */
export function attachmentUrl(id: string): string {
  return `/api/attachments/${id}`;
}

/** task attachment upload endpoint (multipart POST, session-authenticated) */
export function taskAttachmentsUrl(taskId: string): string {
  return `/api/tasks/${taskId}/attachments`;
}
