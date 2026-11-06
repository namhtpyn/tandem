import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { $ } from 'bun';
import { afterAll, describe, expect, it } from 'vitest';

// Contract: SPEC.md "Probe versioning" — scripts/check-probe-drift.sh exits 0
// only when the live profile probe is byte-identical to the repo-versioned copy.
const script = new URL('../../scripts/check-probe-drift.sh', import.meta.url).pathname;
const roots: string[] = [];

async function fixture(repoBody: string, liveBody: string | null) {
  const root = mkdtempSync(join(tmpdir(), 'probe-drift-'));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'scripts/tandem-prod-probe.sh'), repoBody);
  await $`git -C ${repo} init -q`.quiet();
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} -c user.name=t -c user.email=t@t commit -q -m init`.quiet();
  const live = join(root, 'live-probe.sh');
  if (liveBody !== null) writeFileSync(live, liveBody);
  return { repo, live };
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('check-probe-drift', () => {
  it('exits 0 on a byte-identical deploy', async () => {
    const body = '#!/usr/bin/env bash\necho probe\n';
    const { repo, live } = await fixture(body, body);
    const proc = $`bash ${script}`
      .env({ TANDEM_PROBE_REPO: repo, TANDEM_PROBE_LIVE: live, TANDEM_PROBE_REF: 'HEAD' })
      .nothrow()
      .quiet();
    const { exitCode, stderr } = await proc;
    expect(exitCode, stderr.toString()).toBe(0);
  });

  it('exits 1 and names the drift when the live copy differs', async () => {
    const { repo, live } = await fixture('#!/usr/bin/env bash\necho probe\n', '#!/usr/bin/env bash\necho edited\n');
    const proc = $`bash ${script}`
      .env({ TANDEM_PROBE_REPO: repo, TANDEM_PROBE_LIVE: live, TANDEM_PROBE_REF: 'HEAD' })
      .nothrow()
      .quiet();
    const { exitCode, stdout, stderr } = await proc;
    expect(exitCode).toBe(1);
    expect(stdout.toString()).toContain('echo edited');
    expect(stderr.toString()).toContain('probe-drift');
  });

  it('exits 2 when the live copy is missing', async () => {
    const { repo, live } = await fixture('#!/usr/bin/env bash\n', null);
    const proc = $`bash ${script}`
      .env({ TANDEM_PROBE_REPO: repo, TANDEM_PROBE_LIVE: live, TANDEM_PROBE_REF: 'HEAD' })
      .nothrow()
      .quiet();
    const { exitCode, stderr } = await proc;
    expect(exitCode).toBe(2);
    expect(stderr.toString()).toContain('missing');
  });
});
