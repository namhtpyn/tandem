import { expect, test } from './helpers/cleanup';

// SPEC "API law" TEXT-STORABILITY LAW (#382): better-auth's own update-user
// path writes `user.name` / `user.image` straight into Postgres text columns,
// so it refuses NUL and unpaired surrogates with the same field-named BAD_REQUEST
// as every procedure edge — never an opaque driver 500, never a silent U+FFFD
// rewrite. A well-formed astral pair stays accepted. Workers are 1 and the suite
// is serial by file, so renaming the signed-in admin inside one test is safe —
// the original name is restored before the test ends.
// better-auth refuses a cookie-auth POST without an Origin (MISSING_OR_NULL_ORIGIN
// 403); page.request does not send one, so every call pins the app origin.
const ORIGIN = process.env.TANDEM_E2E_URL || 'http://localhost:4100';

const NUL = 'A\u0000B';
const LONE_HIGH = 'A\uD800B';
const ASTRAL = 'Renamed 😀';

test('update-user refuses NUL / lone surrogates and accepts a well-formed astral pair', async ({ page }) => {
  const sessionRes = await page.request.post('/rpc/auth/session', { data: { json: {} } });
  expect(sessionRes.status()).toBe(200);
  const original = ((await sessionRes.json()).json as { user: { name: string } }).user.name;

  for (const bad of [NUL, LONE_HIGH]) {
    const res = await page.request.post('/auth/update-user', { data: { name: bad }, headers: { origin: ORIGIN } });
    expect(res.status(), `name ${JSON.stringify(bad)}`).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('name contains invalid characters');
  }

  const badImage = await page.request.post('/auth/update-user', {
    data: { image: `data:image/png;base64,${LONE_HIGH}` },
    headers: { origin: ORIGIN },
  });
  expect(badImage.status()).toBe(400);
  expect(JSON.stringify(await badImage.json())).toContain('image contains invalid characters');

  try {
    const ok = await page.request.post('/auth/update-user', { data: { name: ASTRAL }, headers: { origin: ORIGIN } });
    expect(ok.status()).toBe(200);
    // the law is about what LANDS in the column: a hook that aborts the write
    // but answers 200 would keep the status pin green
    const after = await page.request.post('/rpc/auth/session', { data: { json: {} } });
    expect(((await after.json()).json as { user: { name: string } }).user.name).toBe(ASTRAL);
  } finally {
    // the signed-in admin is shared by every later spec — restore even when an
    // assertion above failed (a retry would otherwise read the renamed value)
    const restore = await page.request.post('/auth/update-user', {
      data: { name: original },
      headers: { origin: ORIGIN },
    });
    expect(restore.status()).toBe(200);
  }
});
