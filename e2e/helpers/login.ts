import { expect, type Page } from '@playwright/test';

// Deterministic login for e2e specs: the real UI form. The form is SSR'd;
// clicking Sign in before Vue hydration attaches @submit causes a NATIVE form
// post (page reloads, credentials lost, test flakes), so we wait for the
// mounted app's network to settle first.
export async function login(page: Page) {
  // UI-form login: the fast cookie path (better-auth test-utils) dragged
  // drizzle-orm/bun-sql into the playwright worker and its native SQL binding
  // killed the worker process — the UI round-trip is the stable path.
  await page.goto('/');
  // hydration marker: Nuxt sets __NUXT__ / data-nuxt attrs; the reliable
  // signal is the auth/session oRPC POST firing on app mount — instead of
  // sniffing internals we simply require the form to be interactive by
  // waiting for the network the mounted app always makes, then a beat.
  await page.waitForLoadState('networkidle');
  await page.getByPlaceholder('you@example.com').fill('admin@tandem.local');
  await page.getByLabel('Password').fill('tandem-admin');
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  await page.waitForURL((url) => !url.pathname.includes('login'));
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}
