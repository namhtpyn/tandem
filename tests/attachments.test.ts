// Attachments util — pure parts: tokens, mime allowlist, filename sanitizing.
import { describe, expect, it } from 'vitest'
import {
  extractAttachmentIds, mimeAllowed, normalizeMime, sanitizeFilename, stripAttachments,
} from '../server/domains/tasks/attachments.util'

describe('extractAttachmentIds', () => {
  it('collects image and file tokens', () => {
    const desc = 'see ![spec](attachment-abc123) and @[doc.pdf](attachment-def456)'
    expect(extractAttachmentIds(desc)).toEqual(['abc123', 'def456'])
  })
  it('ignores mention tokens', () => {
    expect(extractAttachmentIds('@[Zed](mention-zeed)')).toEqual([])
  })
  it('dedupes repeated ids', () => {
    expect(extractAttachmentIds('![a](attachment-x) ![b](attachment-x)')).toEqual(['x'])
  })
})

describe('stripAttachments', () => {
  it('replaces image and file tokens with their labels', () => {
    expect(stripAttachments('see ![spec](attachment-a1) plus @[doc](attachment-b2)')).toBe('see spec plus doc')
  })
  it('plain text passes through untouched', () => {
    expect(stripAttachments('no tokens here')).toBe('no tokens here')
  })
  it('leaves mentions for stripMentions', () => {
    expect(stripAttachments('@[Zed](mention-zeed)')).toBe('@[Zed](mention-zeed)')
  })
})

describe('normalizeMime / mimeAllowed', () => {
  it('lowercases and strips parameters', () => {
    expect(normalizeMime('IMAGE/PNG; charset=binary')).toBe('image/png')
  })
  it('empty becomes octet-stream', () => {
    expect(normalizeMime(undefined)).toBe('application/octet-stream')
  })
  it('allowlists known types only', () => {
    expect(mimeAllowed('image/png')).toBe(true)
    expect(mimeAllowed('application/x-msdownload')).toBe(false)
  })
})

describe('sanitizeFilename', () => {
  it('strips path separators and odd characters', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('....etcpasswd')
    expect(sanitizeFilename('a<b>c:d')).toBe('abcd')
  })
  it('caps length and defaults to file', () => {
    expect(sanitizeFilename('x'.repeat(300)).length).toBeLessThanOrEqual(120)
    expect(sanitizeFilename('???')).toBe('file')
  })
})
