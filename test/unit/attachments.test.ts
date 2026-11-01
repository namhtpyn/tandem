// Attachments util — pure parts: tokens, mime allowlist, filename sanitizing.
import { describe, expect, it, vi } from 'vitest';

import { env, setEnv } from '#server/domains/kernel/env';
import {
  extractAttachmentIds,
  mimeAllowed,
  normalizeMime,
  sanitizeFilename,
  stripAttachments,
} from '#server/domains/tasks/attachments.util';

describe('DATA_ROOT default', () => {
  it('defaults under /tandem/** when the env is unset (env still wins)', async () => {
    const saved = env.TANDEM_ATTACHMENTS_DIR;
    const mod = await import('#server/domains/tasks/attachments.util');
    setEnv({ TANDEM_ATTACHMENTS_DIR: undefined });
    expect(mod.dataRoot()).toBe('/tandem');
    expect(mod.attachmentPath('t1', 'a1')).toBe('/tandem/tasks/t1/attachments/a1');
    setEnv({ TANDEM_ATTACHMENTS_DIR: saved });
  });
});

describe('deleteTaskAttachmentBytes — BYTES-WITH-TASK (#150)', () => {
  it('sweeps the whole per-task dir — inputs, outputs and stray files gone', async () => {
    const { mkdtemp, rm: fsRm, stat } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'tandem-att-'));
    const saved = env.TANDEM_ATTACHMENTS_DIR;
    setEnv({ TANDEM_ATTACHMENTS_DIR: tmp });
    try {
      const mod = await import('#server/domains/tasks/attachments.util');
      await mod.saveAttachmentBytes('t1', 'a1', Buffer.from('input bytes'));
      await mod.saveAttachmentBytes('t1', 'a2', Buffer.from('collected output'));
      const dir = mod.taskAttachmentsDir('t1');
      expect(await mod.attachmentExists('t1', 'a1')).toBe(true);
      expect(await mod.attachmentExists('t1', 'a2')).toBe(true);

      await mod.deleteTaskAttachmentBytes('t1');

      await expect(stat(dir)).rejects.toThrow(); // the whole dir is gone, not just the files
      expect(await mod.attachmentExists('t1', 'a1')).toBe(false);
      expect(await mod.attachmentExists('t1', 'a2')).toBe(false);
    } finally {
      setEnv({ TANDEM_ATTACHMENTS_DIR: saved });
      await fsRm(tmp, { recursive: true, force: true });
    }
  });

  it('is idempotent and never throws on an already-gone or never-existing dir', async () => {
    const { mkdtemp, rm: fsRm } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'tandem-att-'));
    const saved = env.TANDEM_ATTACHMENTS_DIR;
    setEnv({ TANDEM_ATTACHMENTS_DIR: tmp });
    try {
      const mod = await import('#server/domains/tasks/attachments.util');
      // a task that never had bytes — fine
      await expect(mod.deleteTaskAttachmentBytes('t-none')).resolves.toBeUndefined();
      // sweep twice — the second pass finds nothing and still resolves
      await mod.saveAttachmentBytes('t1', 'a1', Buffer.from('x'));
      await expect(mod.deleteTaskAttachmentBytes('t1')).resolves.toBeUndefined();
      await expect(mod.deleteTaskAttachmentBytes('t1')).resolves.toBeUndefined();
    } finally {
      setEnv({ TANDEM_ATTACHMENTS_DIR: saved });
      await fsRm(tmp, { recursive: true, force: true });
    }
  });
});

describe('attachmentPath guards', () => {
  it('rejects unsafe task ids and attachment ids', async () => {
    const mod = await import('#server/domains/tasks/attachments.util');
    expect(() => mod.attachmentPath('../../escape', 'a1')).toThrow('bad task id');
    expect(() => mod.attachmentPath('t1', '../../escape')).toThrow('bad attachment id');
    expect(() => mod.taskAttachmentsDir('../../escape')).toThrow('bad task id');
    expect(mod.taskAttachmentsDir('t1')).toBe(`${mod.dataRoot()}/tasks/t1/attachments`);
    expect(() => mod.attachmentPath('t1', 'a b')).toThrow('bad attachment id');
    // cleanup with an unsafe task id is a no-op, never a throw
    await expect(mod.deleteTaskAttachmentBytes('../../escape')).resolves.toBeUndefined();
    expect(await mod.attachmentExists('../../escape', 'x')).toBe(false);
    expect(await mod.attachmentExists('t1', 'x')).toBe(false);
  });
});

describe('extractAttachmentIds', () => {
  it('collects image and file tokens', () => {
    const desc = 'see ![spec](attachment-abc123) and @[doc.pdf](attachment-def456)';
    expect(extractAttachmentIds(desc)).toEqual(['abc123', 'def456']);
  });
  it('ignores mention tokens', () => {
    expect(extractAttachmentIds('@[Zed](mention-zeed)')).toEqual([]);
  });
  it('dedupes repeated ids', () => {
    expect(extractAttachmentIds('![a](attachment-x) ![b](attachment-x)')).toEqual(['x']);
  });
});

describe('stripAttachments', () => {
  it('replaces image and file tokens with their labels', () => {
    expect(stripAttachments('see ![spec](attachment-a1) plus @[doc](attachment-b2)')).toBe('see spec plus doc');
  });
  it('plain text passes through untouched', () => {
    expect(stripAttachments('no tokens here')).toBe('no tokens here');
  });
  it('leaves mentions for stripMentions', () => {
    expect(stripAttachments('@[Zed](mention-zeed)')).toBe('@[Zed](mention-zeed)');
  });
});

describe('normalizeMime / mimeAllowed', () => {
  it('lowercases and strips parameters', () => {
    expect(normalizeMime('IMAGE/PNG; charset=binary')).toBe('image/png');
  });
  it('empty becomes octet-stream', () => {
    expect(normalizeMime(undefined)).toBe('application/octet-stream');
  });
  it('allowlists known types only', () => {
    expect(mimeAllowed('image/png')).toBe(true);
    expect(mimeAllowed('application/x-msdownload')).toBe(false);
  });
});

describe('sanitizeFilename', () => {
  it('strips path separators and odd characters', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('....etcpasswd');
    expect(sanitizeFilename('a<b>c:d')).toBe('abcd');
  });
  it('caps length and defaults to file', () => {
    expect(sanitizeFilename('x'.repeat(300)).length).toBeLessThanOrEqual(120);
    expect(sanitizeFilename('???')).toBe('file');
  });
});
