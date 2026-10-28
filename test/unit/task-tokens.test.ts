// task-tokens.ts — builders and parser must agree (they live together for
// exactly this reason, so every arm here round-trips through both sides).
import { describe, expect, it } from 'vitest';

import { attachmentRef, attachmentToken, mentionToken, parseTaskText } from '../../app/utils/task-tokens';

describe('task tokens: builders', () => {
  it('marks image attachments with ! and files with @', () => {
    expect(attachmentToken('image/png', 'shot.png', 'id1')).toBe('![shot.png](attachment-id1)');
    expect(attachmentToken('application/pdf', 'spec.pdf', 'id2')).toBe('@[spec.pdf](attachment-id2)');
  });

  it('escapes names that would break the markdown target', () => {
    expect(attachmentToken('text/plain', 'weird[name](x).txt', 'id3')).toBe('@[weird_name_x_.txt](attachment-id3)');
  });

  it('collapses a run of unsafe chars into one underscore', () => {
    expect(attachmentToken('text/plain', '[]()', 'id4')).toBe('@[_](attachment-id4)');
  });

  it('builds the mention token through the same escaping', () => {
    expect(mentionToken('Ada (AI)', 'e1')).toBe('@[Ada _AI_](mention-e1)');
  });

  it('attachmentRef is the single ref format', () => {
    expect(attachmentRef('x')).toBe('attachment-x');
  });
});

describe('task tokens: parser', () => {
  it('splits text, image, file and mention parts', () => {
    const text = [
      'before',
      '![shot.png](attachment-img1)',
      '@[spec.pdf](attachment-doc1)',
      '@[Ada](mention-e1)',
      'after',
    ].join(' ');
    expect(parseTaskText(text)).toEqual([
      { type: 'text', body: 'before ' },
      { type: 'image', id: 'img1', alt: 'shot.png' },
      { type: 'text', body: ' ' },
      { type: 'file', id: 'doc1', name: 'spec.pdf' },
      { type: 'text', body: ' ' },
      { type: 'mention', label: 'Ada' },
      { type: 'text', body: ' after' },
    ]);
  });

  it('renders an unsafe attachment target as text instead of building a URL', () => {
    const text = '![x](attachment-not;drop)';
    expect(parseTaskText(text)).toEqual([{ type: 'text', body: text }]);
  });

  it('reads the legacy serialized mention span', () => {
    expect(parseTaskText('hi [@ id="e9" label="Bo"] there')).toEqual([
      { type: 'text', body: 'hi ' },
      { type: 'mention', label: 'Bo' },
      { type: 'text', body: ' there' },
    ]);
  });

  it('plain text passes through untouched', () => {
    expect(parseTaskText('just words')).toEqual([{ type: 'text', body: 'just words' }]);
  });
});

describe('task tokens: parser edge arms', () => {
  it('an empty target id renders as text, never a URL', () => {
    expect(parseTaskText('![x](attachment-)')).toEqual([{ type: 'text', body: '![x](attachment-)' }]);
  });

  it('image with empty alt and file with empty name still parse', () => {
    expect(parseTaskText('![](attachment-img9)')).toEqual([{ type: 'image', id: 'img9', alt: '' }]);
    expect(parseTaskText('@[](attachment-doc9)')).toEqual([{ type: 'file', id: 'doc9', name: '' }]);
  });

  it('a leading mention has no text before it and a trailing one none after', () => {
    expect(parseTaskText('@[Ada](mention-e1)')).toEqual([{ type: 'mention', label: 'Ada' }]);
    expect(parseTaskText('go @[Ada](mention-e1)')).toEqual([
      { type: 'text', body: 'go ' },
      { type: 'mention', label: 'Ada' },
    ]);
  });

  it('adjacent mentions split with no text between', () => {
    expect(parseTaskText('@[A](mention-1)@[B](mention-2)')).toEqual([
      { type: 'mention', label: 'A' },
      { type: 'mention', label: 'B' },
    ]);
  });

  it('an empty name sanitizes to the "file" fallback', () => {
    expect(attachmentToken('text/plain', '', 'id5')).toBe('@[file](attachment-id5)');
  });
});
