// E2E: task detail page (Paperclip-style) — create task via UI, click title, land on
// /tasks/:id: chat thread present (brief + composer), sidebar info present, mobile sheet
// carries the same info, back link returns to the list.
import { expect, test } from '@playwright/test'
import { login } from './helpers/login'

test('task title click opens the task detail page', async ({ page }) => {
  await login(page)
  await page.goto('/tasks')
  await page.getByRole('button', { name: 'New task' }).first().click()
  await page.getByPlaceholder('Task title').fill('Info page probe')
  await page.getByRole('button', { name: /Save|Create task/ }).click()
  await page.waitForTimeout(800)

  await page.getByRole('link', { name: 'Info page probe' }).first().click()
  await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 })
  await expect(page.getByRole('heading', { name: 'Info page probe' })).toBeVisible()

  // chat main: empty thread placeholder + composer
  await expect(page.getByText('No activity yet.')).toBeVisible()
  await expect(page.getByPlaceholder('Write a note or review…')).toBeVisible()

  // sidebar: Details + Workflow sections
  await expect(page.getByText('Details', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Workflow', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Status').first()).toBeVisible()
  await expect(page.getByText('Assignee').first()).toBeVisible()

  // back link returns to the list
  await page.getByRole('link', { name: 'Tasks', exact: false }).first().click()
  await expect(page).toHaveURL(/\/tasks$/)
})

test('mobile: sidebar collapses into the info sheet', async ({ page }) => {
  await login(page)
  await page.goto('/tasks')
  await page.getByRole('button', { name: 'New task' }).first().click()
  await page.getByPlaceholder('Task title').fill('Mobile sheet probe')
  await page.getByRole('button', { name: /Save|Create task/ }).click()
  await page.waitForTimeout(800)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('link', { name: 'Mobile sheet probe' }).first().click()
  await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 })

  // composer still primary on mobile; info opens as sheet
  await expect(page.getByPlaceholder('Write a note or review…')).toBeVisible()
  await page.getByTestId('task-info-trigger').click()
  // scope to the visible slideover (the desktop aside is display:none on mobile)
  await expect(page.getByLabel('Task info').getByText('Details', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Task info').getByRole('button', { name: 'Approve' })).toBeVisible()
})
