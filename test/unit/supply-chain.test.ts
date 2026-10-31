// Supply-chain gate (scripts/check-supply-chain.sh) — contract: SPEC.md
// Deployment / supply-chain contract. The gate only runs in CI, so a broken
// check surfaces as a red run AFTER the push; these asserts pin the contract
// at the unit gate (fixture repos are exercised end-to-end through bash).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const GATE = join(REPO_ROOT, 'scripts', 'check-supply-chain.sh');
const SHA = 'a'.repeat(40);
const DIGEST = 'sha256:' + 'b'.repeat(64);

function fixture(workflows: Record<string, string>, dockerfile: string) {
  const root = mkdtempSync(join(tmpdir(), 'supply-chain-'));
  const wfDir = join(root, 'workflows');
  mkdirSync(wfDir);
  for (const [name, content] of Object.entries(workflows)) {
    writeFileSync(join(wfDir, name), content);
  }
  const dockerfilePath = join(root, 'Dockerfile');
  writeFileSync(dockerfilePath, dockerfile);
  const proc = spawnSync('bash', [GATE], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, SUPPLY_CHAIN_DIR: wfDir, SUPPLY_CHAIN_DOCKERFILE: dockerfilePath },
  });
  return { status: proc.status ?? -1, out: proc.stdout };
}

const COMPLIANT_WF = `name: x
on: push
permissions:
  contents: read
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA} # v1
`;
const COMPLIANT_DOCKERFILE = `FROM oven/bun:1.4.4-alpine@${DIGEST} AS build
FROM oven/bun:1.4.4-alpine@${DIGEST} AS runtime
`;

describe('check-supply-chain.sh', () => {
  it('green is silent on a compliant repo', () => {
    const r = fixture({ 'ci.yml': COMPLIANT_WF }, COMPLIANT_DOCKERFILE);
    expect(r.status).toBe(0);
    expect(r.out).toBe('');
  });

  it('flags an action ref pinned by tag instead of SHA', () => {
    const r = fixture({ 'ci.yml': COMPLIANT_WF.replace(`@${SHA}`, '@v7') }, COMPLIANT_DOCKERFILE);
    expect(r.status).toBe(1);
    expect(r.out).toContain('actions/checkout@v7');
    expect(r.out).toContain('40-hex commit SHA');
  });

  it('flags a workflow file with no permissions block', () => {
    const r = fixture({ 'ci.yml': COMPLIANT_WF.replace('permissions:\n  contents: read\n', '') }, COMPLIANT_DOCKERFILE);
    expect(r.status).toBe(1);
    expect(r.out).toContain("no top-level 'permissions:' block");
  });

  it('flags a FROM base pinned by tag alone', () => {
    const r = fixture({ 'ci.yml': COMPLIANT_WF }, COMPLIANT_DOCKERFILE.replace(`@${DIGEST}`, ''));
    expect(r.status).toBe(1);
    expect(r.out).toContain('must be pinned tag@sha256:<digest>');
  });

  it('exempts in-repo ./path actions from the SHA pin', () => {
    const r = fixture(
      { 'ci.yml': COMPLIANT_WF.replace(`actions/checkout@${SHA}`, './.github/actions/local') },
      COMPLIANT_DOCKERFILE,
    );
    expect(r.status).toBe(0);
    expect(r.out).toBe('');
  });

  it('exempts FROM scratch (no base image to pin)', () => {
    const r = fixture({ 'ci.yml': COMPLIANT_WF }, 'FROM scratch\n');
    expect(r.status).toBe(0);
    expect(r.out).toBe('');
  });

  it('fails closed on a missing dockerfile', () => {
    const root = mkdtempSync(join(tmpdir(), 'supply-chain-'));
    const wfDir = join(root, 'workflows');
    mkdirSync(wfDir);
    writeFileSync(join(wfDir, 'ci.yml'), COMPLIANT_WF);
    const proc = spawnSync('bash', [GATE], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, SUPPLY_CHAIN_DIR: wfDir, SUPPLY_CHAIN_DOCKERFILE: join(root, 'absent') },
    });
    expect(proc.status).toBe(1);
    expect(proc.stdout).toContain('missing (fail closed)');
  });

  it('fails closed on a missing workflows dir', () => {
    const proc = spawnSync('bash', [GATE], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        SUPPLY_CHAIN_DIR: join(tmpdir(), `absent-${Date.now()}`),
        SUPPLY_CHAIN_DOCKERFILE: join(tmpdir(), 'absent'),
      },
    });
    expect(proc.status).toBe(1);
    expect(proc.stdout).toContain('missing (fail closed)');
  });

  it('the real repo passes its own gate', () => {
    const proc = spawnSync('bash', [GATE], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(proc.status).toBe(0);
    expect(proc.stdout).toBe('');
  });
});
