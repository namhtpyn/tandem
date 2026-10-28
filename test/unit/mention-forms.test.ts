// Pure check of extractMentionedEmployeeIds via vitest to isolate from db.
import { describe, expect, it } from 'vitest';

import { extractMentionedEmployeeIds } from '#server/domains/tasks/brief.service';

describe('mention forms', () => {
  const map = new Map([
    ['Peer Three', 'p'],
    ['Chief Two', 'c'],
  ]);
  it('bracket label that is not a known employee is ignored', () => {
    const out = extractMentionedEmployeeIds('[@ label="Stranger Thing"]', map);
    expect(out).toEqual([]);
  });
  it('link form', () => {
    const out = extractMentionedEmployeeIds('ping @[Peer Three](mention-p)', map);
    expect(out).toContain('p');
  });
  it('bracket form', () => {
    const out = extractMentionedEmployeeIds('and [@ label="Chief Two"]', map);
    expect(out).toContain('c');
  });
  it('full mixed description as stored by the editor', () => {
    const out = extractMentionedEmployeeIds('ping @[Peer Three](mention-p) and [@ label="Chief Two"]', map);
    expect(out.sort()).toEqual(['c', 'p']);
  });
});
