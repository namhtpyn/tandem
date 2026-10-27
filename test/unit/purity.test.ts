// no-real-DB law: the unit project must never touch the DB — scan guards drift
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const FORBIDDEN_PATTERN = String.raw`#server\/db|helpers\/pg|worker-setup|api-harness|resetData|callProc|makeProcCaller`;
// the guard scans other test files; its own body necessarily names the patterns
const FORBIDDEN = new RegExp(FORBIDDEN_PATTERN);

describe('unit purity', () => {
  it('test/unit files import no database harness', () => {
    const dir = join(import.meta.dirname);
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.test.ts') && f !== 'purity.test.ts')
      .filter((f) => FORBIDDEN.test(readFileSync(join(dir, f), 'utf8')));
    expect(offenders, `DB imports leaked into unit: ${offenders.join(', ')}`).toEqual([]);
  });
});
