// Prompt-image selection (SPEC 2026-10-31): pure split of input attachments
// into ACP-prompt-inlined vs staged-only, with the contract's ceilings pinned.
import { describe, expect, it } from 'vitest';

import {
  PROMPT_IMAGE_MAX_BYTES,
  PROMPT_IMAGE_MAX_COUNT,
  promptImageSplit,
} from '#server/domains/tasks/prompt-images.util';

const f = (id: string, filename: string, mime = 'image/png', size = 1024) => ({ id, filename, mime, size });

describe('promptImageSplit', () => {
  it('no attachments -> nothing inlines', () => {
    expect(promptImageSplit([])).toEqual({ inline: [], staged: [] });
  });

  it('filters non-image mimes to staged', () => {
    const r = promptImageSplit([f('1', 'a.png'), f('2', 'doc.pdf', 'application/pdf'), f('3', 'b.png')]);
    expect(r.inline.map((x) => x.id)).toEqual(['1', '3']);
    expect(r.staged.map((x) => x.id)).toEqual(['2']);
  });

  it('drops empty files and over-cap files', () => {
    const r = promptImageSplit([
      f('empty', 'e.png', 'image/png', 0),
      f('huge', 'h.png', 'image/png', PROMPT_IMAGE_MAX_BYTES + 1),
      f('ok', 'o.png', 'image/png', PROMPT_IMAGE_MAX_BYTES),
    ]);
    expect(r.inline.map((x) => x.id)).toEqual(['ok']);
    expect(r.staged.map((x) => x.id)).toEqual(['empty', 'huge']);
  });

  it('caps the count; later names (asc) stage', () => {
    const files = Array.from({ length: PROMPT_IMAGE_MAX_COUNT + 2 }, (_, i) =>
      f(`id${i}`, `img-${String(i).padStart(2, '0')}.png`),
    );
    const r = promptImageSplit(files);
    expect(r.inline.length).toBe(PROMPT_IMAGE_MAX_COUNT);
    expect(r.staged.length).toBe(2);
    expect(r.inline.at(-1)?.filename).toBe(`img-0${PROMPT_IMAGE_MAX_COUNT - 1}.png`);
  });

  it('enforces the total budget: a file that would overflow stages even if individually valid', () => {
    const r = promptImageSplit([
      f('a', 'a.png', 'image/png', PROMPT_IMAGE_MAX_BYTES), // 5 MiB
      f('b', 'b.png', 'image/png', PROMPT_IMAGE_MAX_BYTES), // 10 MiB total
      f('c', 'c.png', 'image/png', 3 * 1024 * 1024), // 13 MiB > 12 MiB budget -> staged
    ]);
    expect(r.inline.map((x) => x.id)).toEqual(['a', 'b']);
    expect(r.staged.map((x) => x.id)).toEqual(['c']);
  });

  it('is deterministic: shuffled input yields filename-asc inline order', () => {
    const r = promptImageSplit([f('z', 'z.png'), f('a', 'a.png'), f('m', 'm.png')]);
    expect(r.inline.map((x) => x.filename)).toEqual(['a.png', 'm.png', 'z.png']);
  });

  it('partition is complete: inline + staged == input', () => {
    const files = [
      f('1', 'a.png'),
      f('2', 'b.txt', 'text/plain'),
      f('3', 'c.png', 'image/png', 0),
      f('4', 'd.webp', 'image/webp', 2048),
      f('5', 'e.jpg', 'image/jpeg', 3),
    ];
    const r = promptImageSplit(files);
    expect([...r.inline, ...r.staged].sort((a, b) => a.id.localeCompare(b.id)).map((x) => x.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
  });
});
