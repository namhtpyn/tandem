// E2E: task info page — create task via UI, click title, land on /tasks/:id, workflow visible.
import { expect, test } from '@playwright/test'
import { login } from './helpers/login'

test('task title click opens the task info page', async ({ page }) => {
  await login(page)
  await page.goto('/tasks')
  await page.getByRole('button', { name: 'New task' }).first().click()
  await page.getByPlaceholder('Task title').fill('Info page probe')
  await page.getByRole('button', { name: /Save|Create task/ }).click()
  await page.waitForTimeout(800)

  await page.getByRole('link', { name: 'Info page probe' }).first().click()
  await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 })
  await expect(page.getByRole('heading', { name: 'Info page probe' })).toBeVisible()
  await expect(page.getByText('Workflow', { exact: true })).toBeVisible()
  await expect(page.getByText('Agent runs', { exact: true })).toBeVisible()
  await expect(page.getByText('Activity', { exact: true })).toBeVisible()

  // back link returns to the list
  await page.getByRole('link', { name: 'Tasks', exact: false }).first().click()
  await expect(page).toHaveURL(/\/tasks$/)
})
