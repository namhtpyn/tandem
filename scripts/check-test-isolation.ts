// TEST-ISOLATION GUARD (#346): a `vi.hoisted` holder is module state shared by
// every test in its file — with `sequence.shuffle` on, a field a test writes but
// never resets leaks into whichever test runs next (the flaky-suite class:
// retention-leg's fault flag, an accumulating read log, a sticky switch).
//
// The rule, stated exactly: every holder field a test can write must be reset by a
// beforeEach/afterEach on that test's own describe chain. Writes that run once per
// file — module scope, a mock factory, a `beforeAll` — cannot leak between tests
// and are exempt by construction. A single-test file is exempt (no next test).
//
// Parsing runs on the TypeScript AST, never on regex: comments and strings cannot
// fake a reset, and compound assignments (`+=`, `??=`), update expressions,
// mutating methods (`push`/`set`/`clear`/…), `delete`, nested paths (`h.state.open`)
// and one-level aliases (`const rows = h.rows; rows.push(…)`) are all seen.
//
// A holder that genuinely stays file-scoped opts out PER HOLDER — never whole-file
// — with `// isolation-ok(<holder>): <reason>`; the reason is mandatory and every
// exemption is printed so the list stays honest.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

export type Violation = { file: string; holder: string; field: string; reason: string };

const MUTATORS = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
  'set',
  'add',
  'delete',
  'clear',
]);
const TEST_ROOTS = new Set(['it', 'test']);
const TEST_CHAIN = new Set(['each', 'concurrent', 'skip', 'only', 'sequential', 'todo']);
const HOOKS = new Set(['beforeEach', 'afterEach', 'beforeAll']);

type HookKind = 'beforeEach' | 'afterEach' | 'beforeAll';
type Ctx =
  | { kind: 'module'; path: string[] }
  | { kind: 'beforeAll'; path: string[] }
  | { kind: 'hook'; path: string[]; hook: HookKind }
  | { kind: 'test'; path: string[] };

type Site = { holder: string; field: string; kind: 'write' | 'reset'; ctx: Ctx };

function unwrap(node: ts.Node): ts.Node {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function memberName(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    const arg = unwrap(node.argumentExpression);
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  }
  return null;
}

/** root identifier + first member name of `h.state.open` → { root: 'h', field: 'state' } */
function chainRoot(node: ts.Node): { root: string; field: string } | null {
  let current: ts.Node = node;
  const names: string[] = [];
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const name = memberName(current);
    if (name === null) return null;
    names.unshift(name);
    current = current.expression;
  }
  current = unwrap(current);
  if (!ts.isIdentifier(current) || names.length === 0) return null;
  return { root: current.text, field: names[0] as string };
}

/** number of member steps from the root: `h.rows` → 1, `h.state.open` → 2 */
function chainDepth(node: ts.Node): number {
  let current: ts.Node = unwrap(node);
  let depth = 0;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    depth += 1;
    current = unwrap(current.expression);
  }
  return ts.isIdentifier(current) ? depth : 0;
}

function objectFields(node: ts.Node): Set<string> | null {
  const expr = unwrap(node);
  if (!ts.isObjectLiteralExpression(expr)) return null;
  const fields = new Set<string>();
  for (const prop of expr.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      fields.add(prop.name.text);
      continue;
    }
    const name = prop.name;
    if (!name) return null;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
      fields.add(name.text);
      continue;
    }
    return null;
  }
  return fields;
}

function isHoistedCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrap(node.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'hoisted' &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'vi'
  );
}

/** what a `vi.hoisted(…)` factory hands back: an object literal, some other value, or nothing */
function hoistedShape(call: ts.CallExpression): { state: boolean; fields: Set<string> | null } {
  const factory = call.arguments[0];
  if (!factory) return { state: false, fields: null };
  const fn = unwrap(factory);
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return { state: false, fields: null };
  const body = unwrap(fn.body);
  if (ts.isObjectLiteralExpression(body)) return { state: true, fields: objectFields(body) };
  if (ts.isBlock(body)) {
    for (const statement of body.statements) {
      if (ts.isReturnStatement(statement) && statement.expression) {
        const expr = unwrap(statement.expression);
        if (ts.isObjectLiteralExpression(expr)) return { state: true, fields: objectFields(expr) };
      }
    }
  }
  // a hoisted mock function carries no module state of its own (restoreMocks resets it)
  return { state: false, fields: null };
}

type Holder = { name: string; fields: Set<string>; analyzable: boolean };

export function scanHolders(sf: ts.SourceFile): Holder[] {
  const holders: Holder[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrap(node.initializer);
      if (isHoistedCall(init)) {
        const shape = hoistedShape(init);
        const named = ts.isIdentifier(node.name);
        if (shape.state)
          holders.push({
            name: named ? node.name.text : node.name.getText(sf),
            fields: shape.fields ?? new Set(),
            analyzable: named && shape.fields !== null,
          });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return holders;
}

/** `it(…)` / `test(…)` / `it.each(…)(…)` / `it.concurrent(…)` — anything a test runs in */
export function countTests(sf: ts.SourceFile): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee) && TEST_ROOTS.has(callee.text) && node.arguments.length >= 2) count += 1;
      else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        TEST_ROOTS.has(callee.expression.text) &&
        TEST_CHAIN.has(callee.name.text) &&
        node.arguments.length >= 1
      )
        count += 1;
      else if (ts.isCallExpression(callee)) {
        const inner = unwrap(callee.expression);
        if (
          ts.isPropertyAccessExpression(inner) &&
          ts.isIdentifier(inner.expression) &&
          TEST_ROOTS.has(inner.expression.text) &&
          TEST_CHAIN.has(inner.name.text)
        )
          count += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

/** the callback a call runs: the first arg for hooks, the last function arg for it/test/describe */
function callbackBody(node: ts.CallExpression, preferLast = false): ts.Node | null {
  const args = preferLast ? [...node.arguments].reverse() : [...node.arguments];
  for (const arg of args) {
    const fn = unwrap(arg);
    if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) return fn.body;
  }
  return null;
}

/** module-level functions, so a helper called from a hook/test is read in that context */
export function collectFunctions(sf: ts.SourceFile): Map<string, ts.Node> {
  const functions = new Map<string, ts.Node>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) functions.set(node.name.text, node.body);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) functions.set(node.name.text, init.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return functions;
}

function isAssignment(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isPrefix(prefix: string[], full: string[]): boolean {
  return prefix.length <= full.length && prefix.every((value, index) => value === full[index]);
}

function describeTitle(call: ts.CallExpression): string {
  return call.arguments[0]?.getText() ?? 'describe';
}

/** every write/reset site of a holder field, tagged with the context it runs in */
type Alias = { holder: string; field: string };
type Visit = (node: ts.Node, ctx: Ctx, aliases: Map<string, Alias>, expanded: Set<string>) => void;

function aliasResolver(holderNames: Set<string>) {
  return (node: ts.Node, aliases: Map<string, Alias>): Alias | null => {
    const target = unwrap(node);
    const chain = chainRoot(target);
    if (chain && holderNames.has(chain.root)) return { holder: chain.root, field: chain.field };
    if (ts.isIdentifier(target)) return aliases.get(target.text) ?? null;
    return null;
  };
}

function hookContext(kind: HookKind, path: string[]): Ctx {
  return kind === 'beforeAll' ? { kind: 'beforeAll', path } : { kind: 'hook', path, hook: kind };
}

/** calls that carry a test/hook/describe callback; returns true when the node was one */
function visitHookCall(
  node: ts.CallExpression,
  ctx: Ctx,
  visit: Visit,
  aliases: Map<string, Alias>,
  expanded: Set<string>,
  functions: Map<string, ts.Node>,
): boolean {
  const callee = unwrap(node.expression);
  if (!ts.isIdentifier(callee) || !HOOKS.has(callee.text)) return false;
  const next = hookContext(callee.text as HookKind, ctx.path);
  const body = callbackBody(node);
  if (body) visit(body, next, new Map(aliases), new Set(expanded));
  const bare = node.arguments[0] ? unwrap(node.arguments[0]) : null;
  if (!bare || !ts.isIdentifier(bare)) return true;
  const helper = functions.get(bare.text);
  if (!helper || expanded.has(bare.text)) return true;
  visit(helper, next, new Map(aliases), new Set(expanded).add(bare.text));
  return true;
}

/** the callback body of an `it(…)` / `it.each(…)(…)` / `it.concurrent(…)` call, if it is one */
function testCallBody(node: ts.CallExpression, callee: ts.Node): ts.Node | null {
  if (ts.isIdentifier(callee) && TEST_ROOTS.has(callee.text)) return callbackBody(node, true);
  if (!ts.isCallExpression(callee)) return null;
  const inner = unwrap(callee.expression);
  if (!ts.isPropertyAccessExpression(inner)) return null;
  if (!ts.isIdentifier(inner.expression) || !TEST_ROOTS.has(inner.expression.text)) return null;
  return callbackBody(node, true);
}

/** calls that carry a test/hook/describe callback; returns true when the node was one */
function visitScopedCall(
  node: ts.CallExpression,
  ctx: Ctx,
  visit: Visit,
  aliases: Map<string, Alias>,
  expanded: Set<string>,
  functions: Map<string, ts.Node>,
): boolean {
  if (visitHookCall(node, ctx, visit, aliases, expanded, functions)) return true;
  const callee = unwrap(node.expression);
  const testBody = testCallBody(node, callee);
  if (testBody) {
    visit(testBody, { kind: 'test', path: ctx.path }, new Map(aliases), new Set(expanded));
    return true;
  }
  if (ts.isIdentifier(callee) && callee.text === 'describe') {
    const inner = callbackBody(node, true);
    if (inner)
      visit(inner, { ...ctx, path: [...ctx.path, describeTitle(node)] } as Ctx, new Map(aliases), new Set(expanded));
    return true;
  }
  // a local helper runs in the caller's context (seedTask(), drain(), …)
  if (!ts.isIdentifier(callee)) return false;
  if (!functions.has(callee.text) || expanded.has(callee.text)) return false;
  visit(functions.get(callee.text) as ts.Node, ctx, new Map(aliases), new Set(expanded).add(callee.text));
  return true;
}

function binarySites(
  node: ts.BinaryExpression,
  ctx: Ctx,
  aliases: Map<string, Alias>,
  resolve: (n: ts.Node, a: Map<string, Alias>) => Alias | null,
): Site[] {
  if (!isAssignment(node.operatorToken.kind)) return [];
  const left = unwrap(node.left);
  const alias = resolve(left, aliases);
  if (!alias) return [];
  const whole = ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left);
  const plain = node.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  // a whole-field plain assignment is a reset, but only inside a hook — in a test it is
  // just that test's write (a later test that skips the assignment would inherit it)
  if (whole && chainDepth(left) === 1)
    return [{ ...alias, kind: plain && ctx.kind === 'hook' ? 'reset' : 'write', ctx }];
  if (whole && memberName(left) === 'length' && plain)
    return [{ ...alias, kind: ctx.kind === 'hook' ? 'reset' : 'write', ctx }];
  // a nested path (h.state.open) mutates the field without replacing it
  if (whole) return [{ ...alias, kind: 'write', ctx }];
  return [];
}

function mutationSites(
  node: ts.Node,
  ctx: Ctx,
  aliases: Map<string, Alias>,
  resolve: (n: ts.Node, a: Map<string, Alias>) => Alias | null,
): Site[] {
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    const bump = node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken;
    const alias = bump ? resolve(node.operand, aliases) : null;
    return alias ? [{ ...alias, kind: 'write', ctx }] : [];
  }
  if (ts.isDeleteExpression(node)) {
    const alias = resolve(node.expression, aliases);
    return alias ? [{ ...alias, kind: 'write', ctx }] : [];
  }
  if (!ts.isCallExpression(node)) return [];
  const callee = unwrap(node.expression);
  if (!ts.isPropertyAccessExpression(callee)) return [];
  const name = callee.name.text;
  if (MUTATORS.has(name)) {
    const alias = resolve(callee.expression, aliases);
    return alias ? [{ ...alias, kind: name === 'clear' ? 'reset' : 'write', ctx }] : [];
  }
  if (name === 'assign' && ts.isIdentifier(callee.expression) && callee.expression.text === 'Object') {
    const alias = resolve(node.arguments[0] ?? node, aliases);
    return alias ? [{ ...alias, kind: 'write', ctx }] : [];
  }
  return [];
}

export function collectSites(sf: ts.SourceFile, holderNames: Set<string>, functions: Map<string, ts.Node>): Site[] {
  const sites: Site[] = [];
  const resolve = aliasResolver(holderNames);
  const visit: Visit = (node, ctx, aliases, expanded) => {
    if (ts.isCallExpression(node) && visitScopedCall(node, ctx, visit, aliases, expanded, functions)) return;
    // local alias: const rows = h.rows
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer);
      const alias = resolve(init, aliases);
      const wholeField = ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init);
      if (alias && wholeField && chainRoot(init)?.field === alias.field) aliases.set(node.name.text, alias);
    }
    if (ts.isBinaryExpression(node)) sites.push(...binarySites(node, ctx, aliases, resolve));
    sites.push(...mutationSites(node, ctx, aliases, resolve));
    ts.forEachChild(node, (child) => visit(child, ctx, aliases, expanded));
  };
  visit(sf, { kind: 'module', path: [] }, new Map(), new Set());
  return sites;
}

export function auditSource(file: string, src: string): Violation[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (countTests(sf) <= 1) return [];
  const holders = scanHolders(sf);
  if (holders.length === 0) return [];
  const holderNames = new Set(holders.map((holder) => holder.name));
  const sites = collectSites(sf, holderNames, collectFunctions(sf));

  const violations: Violation[] = [];
  for (const holder of holders) {
    const marker = new RegExp(
      String.raw`\/\/[ \t]*isolation-ok\(\s*` +
        holder.name.replace(/[$.*+?^()[\]{}|\\]/g, '\\$&') +
        String.raw`\s*\)[ \t]*:[ \t]*\S`,
    ).test(src);
    if (marker) continue;
    if (!holder.analyzable) {
      violations.push({
        file,
        holder: holder.name,
        field: '(holder)',
        reason: 'not analyzable — declare it as `const h = vi.hoisted(() => ({ … }))`',
      });
      continue;
    }
    const leaking = new Set<string>();
    for (const site of sites) {
      if (site.holder !== holder.name || site.kind !== 'write') continue;
      if (site.ctx.kind === 'module' || site.ctx.kind === 'beforeAll') continue;
      const covered = sites.some(
        (other) =>
          other.holder === holder.name &&
          other.field === site.field &&
          other.kind === 'reset' &&
          other.ctx.kind === 'hook' &&
          isPrefix(other.ctx.path, site.ctx.path),
      );
      if (!covered) leaking.add(site.field);
    }
    for (const field of leaking) {
      violations.push({
        file,
        holder: holder.name,
        field,
        reason: 'written per test but no enclosing beforeEach/afterEach resets it',
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
      violations.push(...auditSource(rel, src));
      for (const m of src.matchAll(/\/\/[ \t]*isolation-ok\(([^)]*)\)[ \t]*:[ \t]*(\S.*)/g)) {
        exemptions.push(`${rel} — ${m[1]?.trim()}: ${m[2]?.trim()}`);
      }
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
