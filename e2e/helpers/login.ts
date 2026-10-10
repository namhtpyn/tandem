import { expect } from '@playwright/test'

// Deterministic UI login for e2e specs. The login form is SSR'd; clicking
// Sign in before Vue hydration attaches @submit causes a NATIVE form post
// (page reloads, credentials lost, test flakes). Waiting for the app's
// hydration marker removes the race for every spec.
export async function login(page: import('@playwright/test').Page) {
  await page.goto('/admin')
  // hydration marker: Nuxt sets __NUXT__ / data-nuxt attrs; the reliable
  // signal is the auth/session oRPC POST firing on app mount — instead of
  // sniffing internals we simply require the form to be interactive by
  // waiting for the network the mounted app always makes, then a beat.
  await page.waitForLoadState('networkidle')
  await page.getByPlaceholder('you@example.com').fill('admin@tandem.local')
  await page.getByLabel('Password').fill('tandem-admin')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/admin/)
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
}

