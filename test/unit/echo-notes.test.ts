// echo-note dedupe: an agent-side re-post of the settled result is the author's own turn
import { describe, expect, it } from 'vitest';

import { dropEchoNotes } from '../../server/domains/tasks/echo-notes.ts';

const at = (s: number) => new Date(1_800_000_000_000 + s * 1000);
const runRow = (authorId: string, body: string, second: number) => ({
  authorId,
  body,
  createdAt: at(second),
  run: { employeeId: authorId },
});
const noteRow = (authorId: string, body: string, second: number) => ({
  authorId,
  body,
  createdAt: at(second),
  run: null,
});

describe('dropEchoNotes', () => {
  it('drops a same-author same-body note within 2min after the run message', () => {
    const rows = [runRow('jay', 'my verdict', 0), noteRow('jay', 'my verdict', 13)];
    expect(dropEchoNotes(rows)).toHaveLength(1);
  });
  it('keeps a different body, a later note, and other authors', () => {
    const rows = [
      runRow('jay', 'my verdict', 0),
      noteRow('jay', 'something else', 5),
      noteRow('jay', 'my verdict', 121),
      noteRow('nam', 'my verdict', 10),
    ];
    expect(dropEchoNotes(rows)).toHaveLength(4);
  });
  it('keeps rows without a run or without an author untouched', () => {
    const rows = [
      { authorId: null, body: 'x', createdAt: at(0), run: null },
      { authorId: 'jay', body: '', createdAt: at(0), run: null },
      runRow('jay', 'verdict', 0),
    ];
    expect(dropEchoNotes(rows)).toHaveLength(3);
  });
});
