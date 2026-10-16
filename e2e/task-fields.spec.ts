import { expect, test, type Page } from '@playwright/test'
import { login } from './helpers/login'

// Task detail Details section: assignee / project / status are editable selects
// (Nuxt UI USelect = role=combobox button + portal options). Status is
// workflow-constrained (current + allowed next statuses); the server enforces
// the same rule and writes a status activity note into the thread.

async function pickOption(page: Page, label: string, option: string) {
  const trigger = page.getByLabel(label)
  await trigger.click()
  await page.getByRole('option', { name: option, exact: true }).click()
  return trigger
}

test('details: change status and assignee from the sidebar', async ({ page }) => {
  const suffix = Date.now().toString(36)
  const employeeName = `E2E Fields ${suffix}`
  await login(page)

  // seed one human employee so the assignee select has a real option
  await page.getByRole('link', { name: /Employees/ }).click()
  await expect(page.getByRole('heading', { name: /Employees/ })).toBeVisible()
  await page.getByRole('button', { name: 'New employee' }).first().click()
  await page.getByPlaceholder('Full name').fill(employeeName)
  await page.getByPlaceholder('name@company.com').fill(`e2e-fields-${suffix}@tandem.local`)
  await page.getByRole('radio', { name: /Human/ }).check()
  await page.getByPlaceholder('Job title').fill('E2E Tester')
  await page.getByRole('button', { name: /Save|Create employee/ }).click()
  await expect(page.locator('tr:visible', { hasText: employeeName })).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: /Done — I saved the key/ }).click()

  // create a task, then open its detail page via the title link
  await page.getByRole('link', { name: /Tasks/, exact: true }).click()
  await expect(page.getByRole('heading', { name: /Tasks/ })).toBeVisible()
  await page.getByRole('button', { name: 'New task' }).first().click()
  await page.getByPlaceholder('Task title').fill('Fields E2E')
  await page.getByRole('button', { name: /Create task/ }).click()
  await expect(page.getByText('Fields E2E').filter({ visible: true }).first()).toBeVisible({ timeout: 15_000 })
  await page.getByRole('link', { name: 'Fields E2E' }).first().click()
  await expect(page.getByRole('heading', { name: /Fields E2E/ })).toBeVisible()

  // status: move along a seeded transition (To do -> Doing); the thread gains
  // the system note and the trigger shows the new status
  const status = await pickOption(page, 'Task status', 'Doing')
  await expect(page.getByText('status:').filter({ visible: true }).first()).toBeVisible({ timeout: 10_000 })
  await expect(status).toContainText('Doing')

  // assignee: pick the seeded employee; survives a reload (persisted via tasks.update)
  const assignee = await pickOption(page, 'Task assignee', employeeName)
  await expect(assignee).toContainText(employeeName)
  await page.reload()
  await expect(page.getByRole('heading', { name: /Fields E2E/ })).toBeVisible()
  await expect(page.getByLabel('Task assignee')).toContainText(employeeName)

  // project select renders with the empty option active (e2e seed has no projects)
  await expect(page.getByLabel('Task project')).toContainText('No project')
})

test('details: status select only offers workflow-allowed transitions', async ({ page }) => {
  await login(page)
  await page.goto('/tasks')
  await page.getByRole('button', { name: 'New task' }).first().click()
  await page.getByPlaceholder('Task title').fill('Fields E2E transitions')
  await page.getByRole('button', { name: /Create task/ }).click()
  await expect(page.getByText('Fields E2E transitions').filter({ visible: true }).first()).toBeVisible({ timeout: 15_000 })
  await page.getByRole('link', { name: 'Fields E2E transitions' }).first().click()
  await expect(page.getByRole('heading', { name: /Fields E2E transitions/ })).toBeVisible()

  // a fresh task sits in the first status; the select must NOT offer every
  // status — e.g. Done is not directly reachable from To do in the seed graph
  await page.getByLabel('Task status').click()
  const options = await page.getByRole('option').allTextContents()
  expect(options.some(o => o.includes('To do'))).toBe(true)
  expect(options.some(o => o.includes('Done'))).toBe(false)
})
