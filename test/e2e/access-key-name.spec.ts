import type { Page } from '@playwright/test';

import { expect, test } from './helpers/cleanup';

// SPEC "Roles & access" — ACCESS-KEY NAME CAP (#367): the credential plugin
// caps key names at 32 chars and throws an APIError oRPC cannot map, so a
// legal employee create with a name longer than 21 chars answered 500 (the
// derived `"<name> access key"` busted the cap), and a caller-supplied name
// over 32 did the same. Derived names fit the cap; caller names over it are
// BAD_REQUEST. Pinned end-to-end on the real handler, not just the helper.
type CreatedEmployee = { id: string; apiKey: string };
type KeyRow = { id: string; name: string };

async function post(page: Page, path: string, json: unknown) {
  return page.request.post(`/rpc/${path}`, { data: { json } });
}

test('employee create with a 100-char name mints a key that fits the 32-char cap', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const name = `${'Long Name '.repeat(9)}${suffix}`.slice(0, 100); // 100 chars
  const res = await post(page, 'employees/create', {
    name,
    email: `long-name-${suffix}@tandem.local`,
    kind: 'human',
    title: 'Tester',
  });
  expect(res.status()).toBe(200);
  const created = (await res.json()).json as CreatedEmployee;
  expect(created.apiKey).toBeTruthy();

  // the stored key metadata carries the derived name — it must fit the plugin cap
  const keysRes = await post(page, 'employees/listApiKeys', { employeeId: created.id });
  expect(keysRes.status()).toBe(200);
  const keys = (await keysRes.json()).json as KeyRow[];
  const minted = keys.find((k) => k.name.endsWith(' access key'));
  expect(minted, `derived key row missing — got ${JSON.stringify(keys.map((k) => k.name))}`).toBeTruthy();
  expect(minted!.name.length).toBeLessThanOrEqual(32);
});

test('caller-supplied key names over 32 chars answer BAD_REQUEST on mint and rename', async ({ page }) => {
  const suffix = Date.now().toString(36);
  const createdRes = await post(page, 'employees/create', {
    name: `Cap ${suffix}`,
    email: `cap-${suffix}@tandem.local`,
    kind: 'human',
    title: 'Tester',
  });
  expect(createdRes.status()).toBe(200);
  const employee = (await createdRes.json()).json as CreatedEmployee;

  // mint: 33 chars -> 400 with the specced message, never a plugin 500
  const tooLong = 'K'.repeat(33);
  const mintRes = await post(page, 'employees/createApiKey', { employeeId: employee.id, name: tooLong });
  expect(mintRes.status()).toBe(400);
  expect(JSON.stringify(await mintRes.json())).toContain('name too long');

  // a fitting name mints, and renaming it over the cap answers the same 400
  const okRes = await post(page, 'employees/createApiKey', { employeeId: employee.id, name: 'primary key' });
  expect(okRes.status()).toBe(200);
  const key = (await okRes.json()).json as KeyRow;
  const renameRes = await post(page, 'employees/updateApiKey', { keyId: key.id, name: tooLong });
  expect(renameRes.status()).toBe(400);
  expect(JSON.stringify(await renameRes.json())).toContain('name too long');
});
