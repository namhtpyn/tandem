import { expect, type Page } from '@playwright/test';

// Deterministic login for e2e specs: the real UI form. The form is SSR'd;
// clicking Sign in before Vue hydration attaches @submit causes a NATIVE form
// post (page reloads, credentials lost, test flakes), and pre-hydration fills
// get wiped by hydration itself — so we gate on hydration COMPLETING, not on
// the network.
export async function login(page: Page) {
  // UI-form login: the fast cookie path (better-auth test-utils) dragged
  // drizzle-orm/bun-sql into the playwright worker and its native SQL binding
  // killed the worker process — the UI round-trip is the stable path.
  await page.goto('/');

  // Race-free hydration gate. waitForLoadState('networkidle') was doubly
  // wrong: the mounted app holds an SSE/live-query stream open (never idle)
  // and a network settle says nothing about Vue. Nuxt flips
  // `useNuxtApp().isHydrating` to false exactly when the root suspense
  // resolves — the moment the SSR'd form's listeners exist. Vue's mount stamp
  // (#__nuxt.__vue_app__) is the fallback if the helper is unavailable.
  await page.waitForFunction(() => {
    try {
      const nuxt = (window as Window & { useNuxtApp?: () => { isHydrating?: boolean } }).useNuxtApp?.();
      if (nuxt) return nuxt.isHydrating === false;
    } catch {
      // no nuxt context outside the app yet — fall through to the Vue stamp
    }
    const root = document.querySelector('#__nuxt') as (Element & { __vue_app__?: unknown }) | null;
    return Boolean(root?.__vue_app__);
  });

  const email = page.getByPlaceholder('you@example.com');
  await email.fill('admin@tandem.local');
  await page.getByLabel('Password').fill('tandem-admin');
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();

  // Signed in = the login card is replaced by the dashboard shell. No URL
  // assertion: login lives at '/', so a pathname check passes vacuously.
  await expect(email).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}
