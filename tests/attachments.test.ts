// Attachments util — pure parts: tokens, mime allowlist, filename sanitizing.
import { describe, expect, it, vi } from 'vitest';

import {
  extractAttachmentIds,
  mimeAllowed,
  normalizeMime,
  sanitizeFilename,
  stripAttachments,
} from '../server/domains/tasks/attachments.util';

describe('DATA_ROOT default', () => {
  it('defaults under /tandem/** when the env is unset (env still wins)', async () => {
    const saved = process.env.TANDEM_ATTACHMENTS_DIR;
    delete process.env.TANDEM_ATTACHMENTS_DIR;
    vi.resetModules();
    const mod = await import('../server/domains/tasks/attachments.util');
    expect(mod.TANDEM_DATA_ROOT).toBe('/tandem');
    expect(mod.attachmentPath('t1', 'a1')).toBe('/tandem/tasks/t1/attachments/a1');
    if (saved) process.env.TANDEM_ATTACHMENTS_DIR = saved;
    vi.resetModules();
  });
});

describe('attachmentPath guards', () => {
  it('rejects unsafe task ids and attachment ids', async () => {
    const mod = await import('../server/domains/tasks/attachments.util');
    expect(() => mod.attachmentPath('../escape', 'a1')).toThrow('bad task id');
    expect(() => mod.attachmentPath('t1', '../escape')).toThrow('bad attachment id');
    expect(() => mod.taskAttachmentsDir('../escape')).toThrow('bad task id');
    expect(mod.taskAttachmentsDir('t1')).toBe(`${mod.TANDEM_DATA_ROOT}/tasks/t1/attachments`);
    expect(() => mod.attachmentPath('t1', 'a b')).toThrow('bad attachment id');
    // delete with unsafe ids is a no-op, never a throw
    expect(() => mod.deleteAttachmentBytes('../escape', 'x')).not.toThrow();
    expect(() => mod.deleteAttachmentBytes('t1', '../escape')).not.toThrow();
    expect(mod.attachmentExists('../escape', 'x')).toBe(false);
    expect(mod.attachmentExists('t1', 'x')).toBe(false);
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
