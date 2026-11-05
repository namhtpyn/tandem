// E2E: channels settings card (SPEC: Channel settings UI, #271 slice 4).
// Admin config surface: create (canonicalized store), strict server refusals
// surface their reason, enabled toggle rewrites, delete removes, and a
// dropped (hand-edited invalid) entry is VISIBLE with its reason. The e2e db
// is truncated by global setup; the `channels` settings row is restored to
// its pre-test state in every cleanup. TANDEM_NO_DISPATCHER=1 in e2e —
// adapters never start, the health chip stays 'no stamp', the list still
// renders (SPEC: list shows STORED entries regardless of adapter liveness).
import { SQL } from 'bun';

import { expect, test } from './helpers/cleanup.ts';
import { E2E_DATABASE_URL } from './helpers/env';
import { BasePage } from './pages/base.page.ts';

const KEY = 'channels';

const sql = new SQL(E2E_DATABASE_URL, { max: 1 });

async function getStored(): Promise<string | null> {
  const rows = await sql`SELECT value FROM settings WHERE key = ${KEY}`;
  return rows.length > 0 ? (rows[0]!.value as string) : null;
}

async function setStored(raw: string | null): Promise<void> {
  if (raw === null) {
    await sql`DELETE FROM settings WHERE key = ${KEY}`;
    return;
  }
  await sql`INSERT INTO settings (key, value, updated_at) VALUES (${KEY}, ${raw}, now())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

async function rpcPost(page: import('@playwright/test').Page, path: string, input: unknown) {
  const res = await page.request.post(path, { data: { json: input } });
  let json: { json?: unknown } = {};
  try {
    json = (await res.json()) as { json?: unknown };
  } catch {
    /* error statuses may carry no json envelope */
  }
  return { status: res.status(), json: json.json as { id?: string } | undefined };
}

async function seedSecret(page: import('@playwright/test').Page, tag: string): Promise<string> {
  const res = await rpcPost(page, '/rpc/vault/secrets/create', {
    name: `Chan token ${tag}`,
    description: '',
    value: 'synapse-bot-token-e2e',
    folderId: null,
  });
  expect(res.status).toBe(200);
  return res.json?.id as string;
}

async function removeSecret(page: import('@playwright/test').Page, id: string): Promise<void> {
  await rpcPost(page, '/rpc/vault/secrets/remove', { id });
}

/** pick the seeded token secret in the editor's USelectMenu */
async function pickSecret(page: import('@playwright/test').Page, tag: string): Promise<void> {
  await page.getByLabel('Token secret').click();
  await page.getByRole('option', { name: new RegExp(`Chan token ${tag}`) }).click();
}

/** open the editor and fill everything but the secret */
async function openEditorWith(page: import('@playwright/test').Page, homeserverUrl: string): Promise<void> {
  await page.getByRole('button', { name: 'New channel' }).first().click();
  await expect(page.getByLabel('Kind')).toBeVisible();
  // single registered kind (matrix) — preselected
  await expect(page.getByLabel('Kind')).toContainText('matrix');
  await page.getByLabel('Homeserver URL').fill(homeserverUrl);
}

test.describe('channels settings card', () => {
  test.afterEach(async () => {
    await setStored(null);
  });

  test('empty state renders with the create entry point', async ({ page }) => {
    const ui = new BasePage(page);
    await ui.navigate('/settings');
    await expect(page.getByRole('heading', { name: 'Channels' })).toBeVisible();
    await expect(page.getByText('No channels yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New channel' }).first()).toBeVisible();
  });

  test('create a channel: stored value is the canonicalized config', async ({ page }) => {
    const ui = new BasePage(page);
    const tag = Date.now().toString(36);
    const secretId = await seedSecret(page, tag);
    try {
      await ui.navigate('/settings');
      await openEditorWith(page, 'https://Matrix.Example.org:443/');
      await pickSecret(page, tag);
      await page.getByRole('button', { name: 'Create channel' }).click();
      await expect(page.getByText('Channel created')).toBeVisible();
      // desktop table + mobile card both render; one row is visible per breakpoint
      await expect(page.getByText('matrix.example.org').filter({ visible: true }).first()).toBeVisible();

      const stored = await getStored();
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored as string) as Array<{ homeserverUrl: string; kind: string; enabled: boolean }>;
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({ kind: 'matrix', enabled: true, homeserverUrl: 'https://matrix.example.org' });
    } finally {
      await removeSecret(page, secretId);
    }
  });

  test('presence-only frontend refusal: empty homeserver blocks submit, nothing stored', async ({ page }) => {
    const ui = new BasePage(page);
    await ui.navigate('/settings');
    await page.getByRole('button', { name: 'New channel' }).first().click();
    await page.getByRole('button', { name: 'Create channel' }).click();
    await expect(page.getByText('Homeserver URL is required')).toBeVisible();
    expect(await getStored()).toBeNull();
  });

  test('duplicate adapter is refused with the server reason, nothing stored', async ({ page }) => {
    const ui = new BasePage(page);
    const tag = Date.now().toString(36);
    const secretId = await seedSecret(page, tag);
    try {
      await ui.navigate('/settings');
      await openEditorWith(page, 'https://matrix.example.org');
      await pickSecret(page, tag);
      await page.getByRole('button', { name: 'Create channel' }).click();
      await expect(page.getByText('Channel created')).toBeVisible();

      // second channel on the SAME canonical homeserver -> strict server refusal
      await openEditorWith(page, 'https://matrix.example.org/');
      await pickSecret(page, tag);
      await page.getByRole('button', { name: 'Create channel' }).click();
      // the refusal renders in the modal AND under the list — same reason text
      await expect(
        page
          .getByText(/duplicate adapter/)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
      const stored = await getStored();
      expect(JSON.parse(stored as string) as unknown[]).toHaveLength(1);
    } finally {
      await removeSecret(page, secretId);
    }
  });

  test('enabled toggle rewrites the stored config', async ({ page }) => {
    const ui = new BasePage(page);
    const tag = Date.now().toString(36);
    // a REAL secret: the admin update checks token-secret existence (the strict
    // path refuses what the tolerant runtime parser would accept)
    const secretId = await seedSecret(page, tag);
    const cfg = [
      {
        kind: 'matrix',
        enabled: true,
        homeserverUrl: 'https://matrix.example.org',
        tokenSecretId: secretId,
        bindings: [],
        defaultAssigneeId: null,
      },
    ];
    try {
      await setStored(JSON.stringify(cfg));
      await ui.navigate('/settings');
      const row = page.locator('tr:visible', { hasText: 'matrix.example.org' }).first();
      await expect(row).toBeVisible();
      await page.getByRole('switch', { name: 'Enable matrix' }).filter({ visible: true }).first().click();
      await expect(page.getByText('Channel updated')).toBeVisible();
      const stored = await getStored();
      expect((JSON.parse(stored as string) as Array<{ enabled: boolean }>)[0]?.enabled).toBe(false);
    } finally {
      await removeSecret(page, secretId);
    }
  });

  test('delete removes the entry after the confirm', async ({ page }) => {
    const ui = new BasePage(page);
    const cfg = [
      {
        kind: 'matrix',
        enabled: false,
        homeserverUrl: 'https://matrix.example.org',
        tokenSecretId: 'seed-secret',
        bindings: [],
        defaultAssigneeId: null,
      },
    ];
    await setStored(JSON.stringify(cfg));
    await ui.navigate('/settings');
    const row = page.locator('tr:visible', { hasText: 'matrix.example.org' }).first();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: /Delete / }).click();
    await ui.confirmDelete();
    await expect(page.getByText('Channel removed')).toBeVisible();
    expect(JSON.parse((await getStored()) as string) as unknown[]).toHaveLength(0);
  });

  test('a dropped entry is visible with its reason (never invisible)', async ({ page }) => {
    const ui = new BasePage(page);
    const cfg = [
      {
        kind: 'matrix',
        enabled: true,
        homeserverUrl: 'https://matrix.example.org',
        tokenSecretId: 'seed-secret',
        bindings: [],
        defaultAssigneeId: null,
      },
      {
        kind: 'slack',
        enabled: true,
        homeserverUrl: 'https://slack.example.org',
        tokenSecretId: 'x',
        bindings: [],
        defaultAssigneeId: null,
      },
    ];
    await setStored(JSON.stringify(cfg));
    await ui.navigate('/settings');
    await expect(page.getByText('https://slack.example.org').filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText('invalid', { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await expect(
      page
        .getByText(/no registered adapter/)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    // the valid row still reads ok
    await expect(page.getByText('matrix.example.org').filter({ visible: true }).first()).toBeVisible();
  });
});
