import { describe, expect, it, vi } from 'vitest';

// RESULT-MESSAGE ATTACHMENTS (SPEC 2026-10-31): images collected from out/ ride the
// run's result message body as tokens; the bubble parses them, the gallery dedupes.

// appendMessageAttachments writes through the server db singleton — capture the
// read + the SET payload instead of touching Postgres (no-real-DB unit law)
const sets: Array<Record<string, unknown>> = [];
let storedBody: string | null = 'result text';
vi.mock('../../server/db/index', () => ({
  db: {
    update: () => ({
      set: (v: Record<string, unknown>) => {
        sets.push(v);
        return { where: async () => {} };
      },
    }),
    query: {
      taskMessages: {
        findFirst: async () => ({ body: storedBody }),
      },
    },
  },
  asDb: (x: unknown) => x,
}));

import { parseTaskText } from '../../app/utils/task-tokens';
import {
  MESSAGE_IMAGE_MAX_BYTES,
  MESSAGE_IMAGE_MAX_COUNT,
  resultImageTokens,
} from '../../server/domains/tasks/result-attachments.util';
import { appendMessageAttachments } from '../../server/domains/tasks/thread.service';

const img = (filename: string, size = 1000, mime = 'image/png', id = `id-${filename}`) => ({
  id,
  filename,
  mime,
  size,
});

describe('resultImageTokens: the message filter', () => {
  it('keeps only the four image mimes — pdf/txt/etc stay gallery-only', () => {
    const tokens = resultImageTokens([
      img('a.png'),
      img('b.pdf', 1000, 'application/pdf'),
      img('c.txt', 1000, 'text/plain'),
      img('d.jpeg', 1000, 'image/jpeg'),
      img('e.webp', 1000, 'image/webp'),
      img('f.gif', 1000, 'image/gif'),
      img('g.tif', 1000, 'image/tiff'),
    ]);
    expect(tokens).toHaveLength(4);
    expect(tokens.every((t) => /^!\[[^\]]+\]\(attachment-id-[a-z]+\.[a-z]+\)$/.test(t))).toBe(true);
  });

  it('drops empty and over-cap files — screenshots, not archives', () => {
    const tokens = resultImageTokens([img('empty.png', 0), img('huge.png', MESSAGE_IMAGE_MAX_BYTES + 1)]);
    expect(tokens).toHaveLength(0);
    expect(resultImageTokens([img('edge.png', MESSAGE_IMAGE_MAX_BYTES)])).toHaveLength(1);
  });

  it('orders by filename asc — the sandbox find order is arbitrary', () => {
    const tokens = resultImageTokens([img('zeta.png'), img('alpha.png'), img('mid.png')]);
    expect(tokens.map((t) => t.slice(2, t.indexOf(']')))).toEqual(['alpha.png', 'mid.png', 'zeta.png']);
  });

  it('caps the count per message; the rest stay gallery rows', () => {
    const files = Array.from({ length: MESSAGE_IMAGE_MAX_COUNT + 2 }, (_, i) => img(`shot-${i}.png`));
    expect(resultImageTokens(files)).toHaveLength(MESSAGE_IMAGE_MAX_COUNT);
  });

  it('tokens round-trip through the app parser — the two sides of the grammar agree', () => {
    const tokens = resultImageTokens([img('ui shot.png', 10, 'image/png', 'u123')]);
    expect(tokens).toEqual(['![ui shot.png](attachment-u123)']);
    const parts = parseTaskText(`done\n\n${tokens.join('\n')}`);
    const images = parts.filter((p) => p.type === 'image');
    expect(images).toEqual([{ type: 'image', id: 'u123', alt: 'ui shot.png' }]);
  });
});

describe('appendMessageAttachments', () => {
  it('appends tokens after the result body, separated by a blank line', async () => {
    sets.length = 0;
    storedBody = 'result text';
    await appendMessageAttachments('m1', ['![a.png](attachment-x)', '![b.png](attachment-y)']);
    expect(sets[0]?.body).toBe('result text\n\n![a.png](attachment-x)\n![b.png](attachment-y)');
  });

  it('a blank body takes the tokens alone', async () => {
    sets.length = 0;
    storedBody = '';
    await appendMessageAttachments('m1', ['![a.png](attachment-x)']);
    expect(sets[0]?.body).toBe('![a.png](attachment-x)');
  });

  it('no tokens -> no write (the parse owns the body)', async () => {
    sets.length = 0;
    storedBody = 'untouched';
    await appendMessageAttachments('m1', []);
    expect(sets).toHaveLength(0);
  });

  it('a message deleted mid-flight never throws', async () => {
    sets.length = 0;
    storedBody = 'result text';
    vi.spyOn((await import('../../server/db/index')).db.query.taskMessages, 'findFirst').mockResolvedValueOnce(null);
    await expect(appendMessageAttachments('m1', ['![a.png](attachment-x)'])).resolves.toBeUndefined();
    expect(sets).toHaveLength(0);
  });
});
