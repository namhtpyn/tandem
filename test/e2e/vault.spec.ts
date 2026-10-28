import { expect, test } from '@playwright/test';

import { VaultPage } from './pages/vault.page.ts';

// Unique-per-run names: a crashed prior run can't poison the unique-name
// constraint on rerun (same pattern as the employees spec).
const RUN = process.pid + '-' + Date.now().toString(36);

test.describe('vault', () => {
  test('secret create/replace/delete round-trip, values never displayed', async ({ page }) => {
    const secName = `e2e-ssh-key-${RUN}`;
    const vault = new VaultPage(page);
    await vault.navigate('/vault');
    await expect(page.getByRole('heading', { name: 'Vault' })).toBeVisible();

    // create
    await vault.createSecret({ name: secName, description: 'e2e round-trip secret', value: 'e2e-secret-value-123' });

    // row appears with hint only — plaintext NEVER rendered
    const row = page.locator('tr:visible', { hasText: secName });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('•••• -123');
    await expect(page.getByText('e2e-secret-value-123')).toHaveCount(0);

    // replace: value rotates, still never shown
    await row.getByRole('button', { name: /Replace / }).click();
    await page.getByRole('textbox', { name: 'Value' }).fill('e2e-rotated-value-999');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('tr:visible', { hasText: secName }).getByText('•••• -999')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('e2e-rotated-value-999')).toHaveCount(0);

    // delete with confirmation
    await page
      .locator('tr:visible', { hasText: secName })
      .getByRole('button', { name: /Delete / })
      .click();
    await vault.confirmDelete();
    await expect(page.locator('tr:visible', { hasText: secName })).toHaveCount(0, { timeout: 15_000 });
  });

  test('duplicate names allowed, description saved and shown', async ({ page }) => {
    const dupName = `e2e-dup-${RUN}`;
    const vault = new VaultPage(page);
    await vault.navigate('/vault');
    for (const [i, desc] of ['first copy', 'second copy'].entries()) {
      await vault.createSecret({ name: dupName, description: desc, value: `v${i}` });
      await expect(page.locator('tr:visible', { hasText: dupName }).nth(i)).toBeVisible({ timeout: 15_000 });
    }
    // both rows exist with their descriptions
    await expect(page.locator('tr:visible', { hasText: dupName })).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator('tr:visible', { hasText: 'first copy' })).toBeVisible();
    await expect(page.locator('tr:visible', { hasText: 'second copy' })).toBeVisible();

    // cleanup both
    for (let i = 0; i < 2; i++) {
      await page
        .locator('tr:visible', { hasText: dupName })
        .first()
        .getByRole('button', { name: /Delete / })
        .click();
      await vault.confirmDelete();
      // each delete settles (row count drops) before the next '.first()' re-resolves
      await expect(page.locator('tr:visible', { hasText: dupName })).toHaveCount(1 - i, { timeout: 15_000 });
    }
    await expect(page.locator('tr:visible', { hasText: dupName })).toHaveCount(0, { timeout: 15_000 });
  });
});
