// Prompt-inline images (SPEC 2026-10-31): input image attachments ride the ACP
// session/prompt itself as image content blocks — the agent sees the ticket's
// screenshots first-hand instead of only reading staged file paths. The filter
// deliberately mirrors the result-message ceilings; everything it drops still
// stages over SFTP (the brief lists the staged path — the fallback arm).
/** mimes that may ride the ACP prompt as image blocks (same set as the message filter) */
export const PROMPT_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** per-file ceiling for a prompt-inlined image — screenshots, not photo dumps */
export const PROMPT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** per-prompt ceiling — six blocks max, same spirit as the message cap */
export const PROMPT_IMAGE_MAX_COUNT = 6;

/** total raw-bytes budget per prompt — bounds the wire after base64's 4/3 expansion */
export const PROMPT_IMAGE_TOTAL_MAX_BYTES = 12 * 1024 * 1024;

export type PromptImageFile = { id: string; filename: string; mime: string; size: number };

/** pure split: which input attachments inline into the prompt vs stay
 * staged-only. Candidates sort filename asc (deterministic — the upload order
 * is arbitrary); a file inlines only when the mime is allowed, the bytes are
 * non-empty and within the per-file cap, the per-prompt count is open, and the
 * running total budget holds. Everything else — non-images included — is
 * staged. */
export function promptImageSplit(files: PromptImageFile[]): { inline: PromptImageFile[]; staged: PromptImageFile[] } {
  const sorted = [...files].sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  const inline: PromptImageFile[] = [];
  const staged: PromptImageFile[] = [];
  let total = 0;
  for (const f of sorted) {
    const fits =
      inline.length < PROMPT_IMAGE_MAX_COUNT &&
      PROMPT_IMAGE_MIMES.has(f.mime) &&
      f.size > 0 &&
      f.size <= PROMPT_IMAGE_MAX_BYTES &&
      total + f.size <= PROMPT_IMAGE_TOTAL_MAX_BYTES;
    if (fits) {
      inline.push(f);
      total += f.size;
    } else {
      staged.push(f);
    }
  }
  return { inline, staged };
}
