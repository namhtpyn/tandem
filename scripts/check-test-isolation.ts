// TEST-ISOLATION GUARD (#346): a `vi.hoisted` holder is module state shared by
// every test in its file — with `sequence.shuffle` on, a holder the tests mutate
// but never reset leaks values into whichever test runs next (the flaky-suite
// class: retention-leg's fault flag, an accumulating read log, a sticky switch).
// A file may only mutate a holder field per test when a `beforeEach` puts it back
// to a known value. This guard enforces that statically, so the leak class cannot
// regress without a red build.
//
// Rules:
//   - every `const h = vi.hoisted(() => ({ ... }))` holder field that the file
//     writes to must be rewritten (or cleared) inside a beforeEach — directly or
//     through a helper the beforeEach calls (one level, e.g. `beforeEach(BEFORE)`);
//   - a single-test file is exempt (nothing can leak between tests);
//   - a legitimate file-scoped holder (seeded once in `beforeAll`, read-only
//     afterwards) opts out with a `// isolation-ok: <reason>` marker — the reason
//     is mandatory and the guard prints every exemption, so the list stays honest.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export type Violation = { file: string; holder: string; field: string; reason: string };

const WRITE_AFTER = String.raw`\s*(?:=(?![=>])|\+\+|--|\.\s*(?:push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|set|add|delete|clear)\s*\(|\.\s*length\s*=)`;
const RESET_AFTER = String.raw`\s*(?:=(?![=>])|\.\s*(?:clear|splice|fill)\s*\(|\.\s*length\s*=\s*0)`;

function balanced(src: string, openIndex: number, open: string, close: string): { body: string; end: number } {
  let depth = 0;
  let i = openIndex;
  while (i < src.length) {
    const ch = src[i] ?? '';
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return { body: src.slice(openIndex + 1, i), end: i + 1 };
    }
    i += 1;
  }
  return { body: src.slice(openIndex + 1), end: src.length };
}

function callBodies(src: string, name: string): string[] {
  const out: string[] = [];
  const call = new RegExp(String.raw`(?<![\w.$])${name}\s*\(`, 'g');
  for (let m = call.exec(src); m; m = call.exec(src)) {
    out.push(balanced(src, m.index + m[0].length - 1, '(', ')').body);
  }
  return out;
}

function callableBodies(src: string, name: string): string[] {
  const out: string[] = [];
  const arrow = new RegExp(
    String.raw`^(?:export\s+)?(?:const|let|var)\s+${name}\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{`,
    'gm',
  );
  for (let m = arrow.exec(src); m; m = arrow.exec(src)) {
    out.push(balanced(src, m.index + m[0].length - 1, '{', '}').body);
  }
  const fn = new RegExp(String.raw`^(?:export\s+)?(?:async\s+)?function\s+${name}\s*\([^)]*\)\s*\{`, 'gm');
  for (let m = fn.exec(src); m; m = fn.exec(src)) {
    out.push(balanced(src, m.index + m[0].length - 1, '{', '}').body);
  }
  return out;
}

/** bodies a beforeEach may run: the hook itself plus the module-scope helpers it calls */
function resetScope(src: string): string {
  const hooks = callBodies(src, 'beforeEach');
  const helpers = new Set<string>();
  for (const hook of hooks) {
    for (const m of hook.matchAll(/(?<![\w.$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1];
      if (name) helpers.add(name);
    }
    // `beforeEach(BEFORE)` hands the hook over whole — the arg text is a bare helper name
    const bare = hook.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(bare)) helpers.add(bare);
  }
  const parts = [...hooks];
  for (const helper of helpers) parts.push(...callableBodies(src, helper));
  return parts.join('\n');
}

function topLevelKeys(objectBody: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let i = 0;
  while (i < objectBody.length) {
    const ch = objectBody[i] ?? '';
    if (ch === '{' || ch === '[' || ch === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(objectBody.slice(i));
      const before = i === 0 ? ',' : (objectBody[i - 1] ?? '');
      if (m && (before === ',' || before === '\n' || before === '{' || before === ' ' || before === '\t')) {
        const key = m[1];
        if (key) keys.push(key);
        i += m[0].length;
        continue;
      }
    }
    i += 1;
  }
  return keys;
}

type Holder = { name: string; fields: string[]; spans: Array<[number, number]> };

export function scanHolders(src: string): Holder[] {
  const holders: Holder[] = [];
  const decl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*vi\.hoisted\s*\(/g;
  for (let m = decl.exec(src); m; m = decl.exec(src)) {
    const open = m.index + m[0].length - 1;
    const call = balanced(src, open, '(', ')');
    const fields: string[] = [];
    const spans: Array<[number, number]> = [[m.index, call.end]];
    // arrow head: `() =>` / `(x) =>` / `async () =>`, then `({ … })` or `{ return { … } }`
    const arrow = /(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(call.body);
    if (arrow) {
      let cursor = open + 1 + arrow.index + arrow[0].length;
      while (cursor < call.end && /\s/.test(src[cursor] ?? '')) cursor += 1;
      if (src[cursor] === '(') cursor += 1;
      if (src[cursor] === '{') {
        const first = balanced(src, cursor, '{', '}');
        const ret = src.slice(cursor, first.end).search(/\breturn\b/);
        let target = cursor;
        if (ret >= 0) {
          const rb = src.indexOf('{', cursor + ret);
          target = rb >= 0 && rb < first.end ? rb : -1;
        }
        if (target >= 0) {
          const obj = balanced(src, target, '{', '}');
          fields.push(...topLevelKeys(obj.body));
        }
      }
    }
    const name = m[1] ?? '';
    holders.push({ name, fields, spans });
  }
  return holders;
}

const TEST_CALL = /(?<![\w.$])(?:it|test)(?:\.each(?:<[^>]*>)?\([^)]*\))?\(\s*['"`]/g;

export function countTests(src: string): number {
  return [...src.matchAll(TEST_CALL)].length;
}

export function auditSource(file: string, src: string): Violation[] {
  const violations: Violation[] = [];
  if (countTests(src) <= 1) return violations;
  const exempt = /\/\/[ \t]*isolation-ok:[ \t]*\S/.test(src);
  if (exempt) return violations;

  const holders = scanHolders(src);
  if (holders.length === 0) return violations;

  const scope = resetScope(src);
  for (const holder of holders) {
    // blank the hoisted blocks: only writes OUTSIDE the declaration count
    let outside = src;
    for (const [start, end] of holder.spans)
      outside = outside.slice(0, start) + ' '.repeat(end - start) + outside.slice(end);
    for (const field of holder.fields) {
      const ref = String.raw`(?<![\w.$])${holder.name}\s*\.\s*${field}(?![\w$])`;
      const writes = new RegExp(ref + WRITE_AFTER, 'g');
      if (!writes.test(outside)) continue;
      const resets = new RegExp(ref + RESET_AFTER);
      if (resets.test(scope)) continue;
      violations.push({
        file,
        holder: holder.name,
        field,
        reason: 'mutated outside the hoisted block but never reset in a beforeEach',
      });
    }
  }
  return violations;
}

export function auditTree(root: string): { violations: Violation[]; scanned: number; exemptions: string[] } {
  const violations: Violation[] = [];
  const exemptions: string[] = [];
  let scanned = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const entryPath = path.join(dir, entry);
      if (statSync(entryPath).isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (!entry.endsWith('.test.ts')) continue;
      const src = readFileSync(entryPath, 'utf8');
      if (!src.includes('vi.hoisted')) continue;
      scanned += 1;
      const rel = path.relative(root, entryPath);
      const found = auditSource(rel, src);
      if (found.length) violations.push(...found);
      const marker = src.match(/\/\/[ \t]*isolation-ok:[ \t]*(\S.*)/);
      const reason = marker?.[1]?.trim();
      if (reason) exemptions.push(`${rel} — ${reason}`);
    }
  };
  walk(root);
  return { violations, scanned, exemptions };
}

function main(): number {
  const root = process.argv[2] ?? 'test/unit';
  const { violations, scanned, exemptions } = auditTree(root);
  for (const note of exemptions) process.stdout.write(`isolation-ok: ${note}\n`);
  if (violations.length === 0) {
    process.stdout.write(`test isolation: ${scanned} hoisted-state files OK\n`);
    return 0;
  }
  process.stderr.write(`test isolation: ${violations.length} unreset hoisted field(s)\n`);
  for (const v of violations) process.stderr.write(`  ${v.file}: ${v.holder}.${v.field} — ${v.reason}\n`);
  return 1;
}

if (import.meta.main) process.exit(main());
