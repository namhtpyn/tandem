import { expect, type Page } from '@playwright/test';

// Deterministic login for e2e specs.
//
// Default path (TANDEM_E2E_FAST_LOGIN unset): the real UI form. The login
// form is SSR'd; clicking Sign in before Vue hydration attaches @submit causes
// a NATIVE form post (page reloads, credentials lost, test flakes), so we wait
// for the mounted app's network to settle first.
//
// Fast path (TANDEM_E2E_FAST_LOGIN=1): better-auth test-utils. A test-only
// auth instance (buildAuthForTest: same DB + config, plus the test-utils
// plugin) creates a session server-side and hands back the session cookie;
// we inject it straight into the browser context — no UI round-trip. The
// helper process points DATABASE_URL at the same database the e2e server
// uses (TANDEM_E2E_DATABASE_URL, set by playwright's webServer env).
export async function login(page: Page) {
  if (process.env.TANDEM_E2E_FAST_LOGIN === '1') {
    await fastLogin(page);
    return;
  }
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

async function fastLogin(page: Page) {
  process.env.DATABASE_URL ||=
    process.env.TANDEM_E2E_DATABASE_URL || 'postgresql://tandem:tandem@127.0.0.1:55432/tandem_e2e';
  const { db } = await import('../../server/db');
  const schema = await import('../../server/db/schema');
  const drizzle = await import('drizzle-orm');
  const userTable = schema.user;
  const eq = drizzle.eq;
  const admin = (await db.select().from(userTable).where(eq(userTable.email, 'admin@tandem.local')).limit(1))[0];
  if (!admin)
    throw new Error(
      'fast-login: admin@tandem.local missing — seed it first, or unset TANDEM_E2E_FAST_LOGIN to use the UI form',
    );
  const { buildAuthForTest } = await import('../../server/domains/auth/auth.service');
  const testAuth = (await buildAuthForTest()) as unknown as {
    $context: Promise<{
      test: {
        login: (o: {
          userId: string;
        }) => Promise<{ cookies: Array<{ name: string; value: string; attributes?: Record<string, unknown> }> }>;
      };
    }>;
  };
  const ctx = await testAuth.$context;
  const { cookies } = await ctx.test.login({ userId: admin.id });
  const url = new URL(process.env.TANDEM_E2E_URL || 'http://localhost:4100');
  await page.context().addCookies(
    cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: url.hostname,
      path: (c.attributes?.path as string) || '/',
      httpOnly: true,
      sameSite: 'Lax',
    })),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}
