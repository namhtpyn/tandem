import { expect, test } from '@playwright/test'
import { login } from './helpers/login'

// Unique-per-run names: a crashed prior run can't poison the unique-name
// constraint on rerun (same pattern as the employees spec).
const RUN = process.pid + '-' + Date.now().toString(36)

test.describe('vault', () => {
  test('secret create/replace/delete round-trip, values never displayed', async ({ page }) => {
    const secName = `e2e-ssh-key-${RUN}`
    await login(page)
    await page.goto('/vault')
    await expect(page.getByRole('heading', { name: 'Vault' })).toBeVisible()

    // create
    await page.getByRole('button', { name: 'New secret' }).first().click()
    await page.getByRole('textbox', { name: 'Name' }).fill(secName)
    await page.getByLabel('Kind').click()
    await page.getByRole('option', { name: 'ssh-key' }).click()
    await page.getByRole('textbox', { name: 'Value' }).fill('e2e-secret-value-123')
    await page.getByRole('button', { name: 'Save' }).click()

    // row appears with hint only — plaintext NEVER rendered
    const row = page.locator('tr:visible', { hasText: secName })
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row).toContainText('•••• -123')
    await expect(page.getByText('e2e-secret-value-123')).toHaveCount(0)

    // replace: value rotates, still never shown
    await row.getByRole('button', { name: 'Replace secret' }).click()
    await page.getByRole('textbox', { name: 'Value' }).fill('e2e-rotated-value-999')
    await page.getByRole('button', { name: 'Replace' }).click()
    await expect(page.locator('tr:visible', { hasText: secName }).getByText('•••• -999')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('e2e-rotated-value-999')).toHaveCount(0)

    // audit log records create + update
    await page.getByRole('button', { name: 'Audit log' }).click()
    await expect(page.getByText('Vault audit log')).toBeVisible()
    await expect(page.getByRole('dialog').getByText(secName).first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('update', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
    await page.keyboard.press('Escape')

    // delete with confirmation
    await page.locator('tr:visible', { hasText: secName }).getByRole('button', { name: 'Delete secret' }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.locator('tr:visible', { hasText: secName })).toHaveCount(0, { timeout: 15_000 })
  })

  test('duplicate name shows a field-level conflict error', async ({ page }) => {
    const dupName = `e2e-dup-${RUN}`
    await login(page)
    await page.goto('/vault')
    await page.getByRole('button', { name: 'New secret' }).first().click()
    await page.getByRole('textbox', { name: 'Name' }).fill(dupName)
    await page.getByRole('textbox', { name: 'Value' }).fill('v1')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.locator('tr:visible', { hasText: dupName })).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: 'New secret' }).first().click()
    await page.getByRole('textbox', { name: 'Name' }).fill(dupName)
    await page.getByRole('textbox', { name: 'Value' }).fill('v2')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/already exists/i).first()).toBeVisible({ timeout: 15_000 })

    // cleanup
    await page.keyboard.press('Escape')
    await page.locator('tr:visible', { hasText: dupName }).getByRole('button', { name: 'Delete secret' }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.locator('tr:visible', { hasText: dupName })).toHaveCount(0, { timeout: 15_000 })
  })
})
