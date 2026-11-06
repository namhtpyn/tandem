import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { $ } from 'bun';
import { afterAll, describe, expect, it } from 'vitest';

// Contract: SPEC.md "Probe versioning" — scripts/check-probe-drift.sh exits 0
// only when the live profile probe is byte-identical to the repo copy at
// origin/dev, and it FETCHES first so a stale local ref cannot green-light drift.
const script = new URL('../../scripts/check-probe-drift.sh', import.meta.url).pathname;
const roots: string[] = [];

async function fixture(body: string) {
  const root = mkdtempSync(join(tmpdir(), 'probe-drift-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  mkdirSync(origin, { recursive: true });
  await $`git init -q --bare ${origin}`.quiet();
  await $`git clone -q ${origin} ${repo}`.quiet();
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'scripts/tandem-prod-probe.sh'), body);
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} -c user.name=t -c user.email=t@t commit -q -m init`.quiet();
  await $`git -C ${repo} push -q origin HEAD:dev`.quiet();
  // Mimic the production clone's LIMITED refspec: a plain `fetch origin dev`
  // must NOT create refs/remotes/origin/dev (only the checker's explicit refspec does).
  await $`git -C ${repo} config remote.origin.fetch +refs/heads/main:refs/remotes/origin/main`.quiet();
  await $`git -C ${repo} fetch -q origin +refs/heads/dev:refs/remotes/origin/dev`.quiet();
  const live = join(root, 'live-probe.sh');
  writeFileSync(live, body);
  return { root, origin, repo, live };
}

function run(repo: string, live: string, extra: Record<string, string> = {}) {
  return $`bash ${script}`
    .env({ TANDEM_PROBE_TEST: '1', TANDEM_PROBE_REPO: repo, TANDEM_PROBE_LIVE: live, ...extra })
    .nothrow()
    .quiet();
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('check-probe-drift', () => {
  it('exits 3 (test-mode identity, never 0) on a byte-identical deploy', async () => {
    const { repo, live } = await fixture('#!/usr/bin/env bash\necho probe\n');
    const proc = run(repo, live);
    const { exitCode, stdout } = await proc;
    expect(exitCode).toBe(3);
    expect(stdout.toString()).toContain('TEST-MODE identical');
  });

  it('exits 1 and names the drift when the live copy differs', async () => {
    const { repo, live } = await fixture('#!/usr/bin/env bash\necho probe\n');
    writeFileSync(live, '#!/usr/bin/env bash\necho edited\n');
    const proc = run(repo, live);
    const { exitCode, stdout, stderr } = await proc;
    expect(exitCode).toBe(1);
    expect(stdout.toString()).toContain('echo edited');
    expect(stderr.toString()).toContain('probe-drift');
  });

  it('fetches origin/dev before comparing (stale local ref cannot pass)', async () => {
    const { root, origin, repo, live } = await fixture('#!/usr/bin/env bash\necho v1\n');
    const other = join(root, 'other');
    await $`git clone -q -b dev ${origin} ${other}`.quiet();
    writeFileSync(join(other, 'scripts/tandem-prod-probe.sh'), '#!/usr/bin/env bash\necho v2\n');
    await $`git -C ${other} add -A`.quiet();
    await $`git -C ${other} -c user.name=t -c user.email=t@t commit -q -m v2`.quiet();
    await $`git -C ${other} push -q origin HEAD:dev`.quiet();
    const proc = run(repo, live);
    const { exitCode, stdout } = await proc;
    expect(exitCode).toBe(1);
    expect(stdout.toString()).toContain('echo v2');
  });

  it('exits 2 when the live copy is missing', async () => {
    const { root, repo } = await fixture('#!/usr/bin/env bash\n');
    const proc = run(repo, join(root, 'missing.sh'));
    const { exitCode, stderr } = await proc;
    expect(exitCode).toBe(2);
    expect(stderr.toString()).toContain('missing');
  });

  it('--deploy replaces the live copy atomically from the fetched blob', async () => {
    const { repo, live } = await fixture('#!/usr/bin/env bash\necho v1\n');
    writeFileSync(live, '#!/usr/bin/env bash\necho stale\n');
    const dep = await $`bash ${script} --deploy`
      .env({ TANDEM_PROBE_TEST: '1', TANDEM_PROBE_REPO: repo, TANDEM_PROBE_LIVE: live })
      .nothrow()
      .quiet();
    expect(dep.exitCode).toBe(0);
    const check = await run(repo, live);
    expect(check.exitCode).toBe(3);
  });
});
