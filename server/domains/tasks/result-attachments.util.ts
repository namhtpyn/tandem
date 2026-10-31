// Result-message attachments (SPEC 2026-10-31): image outputs ride the run's
// result message body itself — the message carries its screenshots everywhere
// the body renders, not just in the deliverable gallery below the bubble.
// The filter is deliberately narrower than collection: non-images, over-cap
// files and everything past the per-message count still collect as gallery
// rows — they only stop short of the message body.
/** mimes that may ride the result message body (the image half of the upload allowlist) */
export const MESSAGE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** per-file ceiling for a message-inlined image — screenshots, not archives */
export const MESSAGE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** per-message ceiling — a wall of 30 thumbnails is not a result message */
export const MESSAGE_IMAGE_MAX_COUNT = 6;

export type ResultFile = { id: string; filename: string; mime: string; size: number };

/** image files that ride the result message: mime filter, non-empty + size cap,
 * deterministic order (filename asc — the sandbox `find` order is arbitrary),
 * capped count. Output = the exact `![name](attachment-<id>)` tokens appended
 * to the message body. Filenames arrive pre-sanitized (sanitizeFilename at row
 * insert), so they cannot break the markdown target. */
export function resultImageTokens(files: ResultFile[]): string[] {
  return files
    .filter((f) => MESSAGE_IMAGE_MIMES.has(f.mime) && f.size > 0 && f.size <= MESSAGE_IMAGE_MAX_BYTES)
    .sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0))
    .slice(0, MESSAGE_IMAGE_MAX_COUNT)
    .map((f) => `![${f.filename}](attachment-${f.id})`);
}
