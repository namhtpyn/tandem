import { expect, type Page } from '@playwright/test';

import { E2E_ADMIN_EMAIL, E2E_ADMIN_ROTATED_PASSWORD, E2E_ADMIN_SEED_PASSWORD } from './env';

// Deterministic sign-in guard for e2e specs: the real UI form, no-op when the
// setup project's storageState already signed the context in (the '/' shell
// renders the dashboard, not the login card, once a session cookie exists).
// The form is SSR'd;
// clicking Sign in before Vue hydration attaches @submit causes a NATIVE form
// post (page reloads, credentials lost, test flakes), and pre-hydration fills
// get wiped by hydration itself — so we gate on hydration COMPLETING, not on
// the network.
/** hydration gate shared by every form-driving helper (login-flake law): the
 *  SSR'd form renders before Vue attaches @submit — clicking early causes a
 *  NATIVE form post (reload, state lost). Nuxt flips isHydrating false when
 *  the root suspense resolves; the Vue mount stamp is the fallback. */
export async function waitForHydration(page: Page) {
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
}

export async function login(page: Page) {
  await page.goto('/');

  // Race-free hydration gate — see waitForHydration.
  await waitForHydration(page);

  // storageState reuse: after the hydration gate the Overview shell is already
  // mounted iff the session cookie is valid — nothing to fill, done. PROBED,
  // not sampled once: the shell mounts only after the first fetch resolves, so
  // a single isVisible() can race it (retry until either surface answers).
  const overview = page.getByRole('heading', { name: 'Overview' });
  const email = page.getByPlaceholder('you@example.com');
  let signedIn: boolean | 'pending' = 'pending';
  await expect
    .poll(
      async () => {
        if (await overview.isVisible().catch(() => false)) signedIn = true;
        else if (await email.isVisible().catch(() => false)) signedIn = false;
        return signedIn;
      },
      { timeout: 10_000 },
    )
    .not.toBe('pending');
  if (signedIn) return;

  // ROTATION-AWARE sign-in (SPEC "Boot seed law"): try the rotated password
  // first (already-rotated DB); on an invalid-credentials alert the seed
  // password is still live — sign in with it and complete the forced rotation.
  const password = page.getByLabel('Password');
  const signIn = page.getByRole('button', { name: 'Sign in', exact: true }).first();
  await email.fill(E2E_ADMIN_EMAIL);
  await password.fill(E2E_ADMIN_ROTATED_PASSWORD);
  await signIn.click();
  const badCredentials = page.getByText('Invalid email or password');
  let seedStillLive = false;
  await expect
    .poll(
      async () => {
        if (await badCredentials.isVisible().catch(() => false)) seedStillLive = true;
        return seedStillLive || (await overview.isVisible().catch(() => false));
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  if (seedStillLive) {
    await password.fill(E2E_ADMIN_SEED_PASSWORD);
    await signIn.click();
    await completeForcedRotation(page);
  }

  // Signed in = the login card is replaced by the dashboard shell. No URL
  // assertion: login lives at '/', so a pathname check passes vacuously.
  await expect(email).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}

/** FIRST-LOGIN ROTATION (SPEC "Boot seed law"): the seeded admin's first
 *  sign-in MUST land on the set-new-password screen before the dashboard —
 *  this is the e2e acceptance for the forced rotation. The current-password
 *  field arrives prefilled from the login just typed; fill new + confirm. */
export async function completeForcedRotation(page: Page) {
  // login() ended with window.location.reload() — the rotation card SSRs
  // during the reload; clicking before hydration re-attaches @submit would
  // native-post the form and bounce right back to the card
  await waitForHydration(page);
  const heading = page.getByRole('heading', { name: 'Set a new password' });
  await expect(heading).toBeVisible();
  await page.getByLabel('New password', { exact: true }).fill(E2E_ADMIN_ROTATED_PASSWORD);
  await page.getByLabel('Confirm new password').fill(E2E_ADMIN_ROTATED_PASSWORD);
  await page.getByRole('button', { name: 'Save password', exact: true }).click();
  await expect(heading).toBeHidden();
}
