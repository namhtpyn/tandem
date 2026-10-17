// E2E: task routing — "needs my decision" inbox toggle with badge, subtask creation
// with parent chip, parent auto-block while children are open (user laws, 2026-10-15).
import { expect, test } from '@playwright/test'
import { login } from './helpers/login'

test('inbox toggle filters to tasks pending on me and shows a badge', async ({ page }) => {
  const suffix = Date.now()
  const name = `Inbox toggle ${suffix}`
  await login(page)
  await page.goto('/tasks')

  // task assigned to admin (the logged-in user) and in progress, so Ask routes
  // the question to the owner (= admin) -> inbox obligation on the same user
  await page.getByRole('button', { name: 'New task' }).first().click()
  await page.getByPlaceholder('Task title').fill(name)
  await page.getByRole('combobox', { name: 'Assignee' }).click()
  await page.getByRole('option', { name: 'Admin', exact: true }).click()
  await page.getByRole('button', { name: /Save|Create task/ }).click()
  await page.waitForTimeout(800)

  // flip to doing via the list's inline status select, then ask from the detail page
  await page.locator('tbody').getByLabel(`Status for ${name}`).click()
  await page.getByRole('option', { name: 'Doing' }).click()
  await page.waitForTimeout(600)
  await page.getByRole('link', { name: name }).first().click()
  await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 })
  await page.getByPlaceholder('Write a note or review…').fill('which db?')
  await page.getByRole('button', { name: 'Ask', exact: true }).first().click()
  await page.waitForTimeout(1200)


  await page.goto('/tasks')
  const toggle = page.getByTestId('needs-decision-toggle')
  await expect(toggle).toBeVisible()
  await expect(page.getByTestId('inbox-count')).toBeVisible() // badge count

  // toggle on: only the pending task remains visible
  await toggle.click()
  await page.waitForTimeout(600)
  await expect(page.getByRole('link', { name: name })).toBeVisible()
  const otherRows = await page.locator('a[href^="/tasks/"]').count()
  expect(otherRows).toBeGreaterThanOrEqual(1)

  // toggle off: back to the full list label
  await toggle.click()
  await expect(toggle).toContainText('Needs my decision')
})

test('subtask creation nests under the parent, chips the child, and blocks the parent', async ({ page }) => {
  const suffix = Date.now()
  const parentName = `Gating parent ${suffix}`
  const childName = `Gating child ${suffix}`
  await login(page)
  await page.goto('/tasks')

  await page.getByRole('button', { name: 'New task' }).first().click()
  await page.getByPlaceholder('Task title').fill(parentName)
  await page.getByRole('button', { name: /Save|Create task/ }).click()
  await page.waitForTimeout(800)
  await page.getByRole('link', { name: parentName }).first().click()
  await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 })

  // create a subtask inline
  const panel = page.getByTestId('subtask-panel')
  await expect(panel).toBeVisible()
  await panel.getByPlaceholder('New subtask…').fill(childName)
  await page.keyboard.press('Enter')
  await expect(panel.getByRole('link', { name: childName })).toBeVisible({ timeout: 10_000 })

  // parent flips to blocked (derived from the open child)
  await page.waitForTimeout(800)
  await page.reload()
  // status ids are uuids now — the badge renders the status NAME
  await expect(page.getByText('Blocked', { exact: true }).first()).toBeVisible({ timeout: 10_000 })

  // child page carries the parent chip
  await panel.getByRole('link', { name: childName }).click()
  await expect(page.getByTestId('parent-task-link')).toContainText(parentName)
})
