import { expect, type Page } from '@playwright/test';

// Deterministic sign-in guard for e2e specs: the real UI form, no-op when the
// setup project's storageState already signed the context in (the '/' shell
// renders the dashboard, not the login card, once a session cookie exists).
// The form is SSR'd;
// clicking Sign in before Vue hydration attaches @submit causes a NATIVE form
// post (page reloads, credentials lost, test flakes), and pre-hydration fills
// get wiped by hydration itself — so we gate on hydration COMPLETING, not on
// the network.
export async function login(page: Page) {
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

  // storageState reuse: after the hydration gate the Overview shell is already
  // mounted iff the session cookie is valid — nothing to fill, done.
  const overview = page.getByRole('heading', { name: 'Overview' });
  if (await overview.isVisible()) return;

  const email = page.getByPlaceholder('you@example.com');
  await email.fill('admin@tandem.local');
  await page.getByLabel('Password').fill('tandem-admin');
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();

  // Signed in = the login card is replaced by the dashboard shell. No URL
  // assertion: login lives at '/', so a pathname check passes vacuously.
  await expect(email).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}
