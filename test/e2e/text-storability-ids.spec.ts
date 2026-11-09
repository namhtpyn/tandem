import type { Page } from '@playwright/test';

import { expect, test } from './helpers/cleanup';

// TEXT-STORABILITY LAW (#386, SPEC "API law"): a text-typed id arrives as a
// query parameter, a write target, a store key or a list filter. A NUL used to
// pass `z.string().min(1)` and reach Postgres, which raised
// 'invalid byte sequence for encoding "UTF8": 0x00' — an opaque 500 instead of
// the specced BAD_REQUEST. This spec drives the real HTTP + schema + handler
// path for the surfaces #386 names, and proves a valid id still resolves.
const NUL = 'A\u0000B';
const LONE = 'A\uD800B';

async function post(page: Page, path: string, json: Record<string, unknown>) {
  return page.request.post(`/rpc/${path}`, { data: { json } });
}

async function expectStorableRefusal(
  page: Page,
  path: string,
  base: Record<string, unknown>,
  key: string,
  field: string,
) {
  for (const bad of [NUL, LONE]) {
    const res = await post(page, path, { ...base, [key]: bad });
    expect(res.status(), `${path} ${key}`).toBe(400);
    expect(JSON.stringify(await res.json()), `${path} ${key}`).toContain(
      `${field} contains invalid characters (NUL or a lone surrogate)`,
    );
  }
}

test('text-typed ids refuse unstorable bytes at the procedure edge, never a 500', async ({ page }) => {
  const created = await post(page, 'tasks/create', { title: `Storable id ${Date.now().toString(36)}` });
  expect(created.status()).toBe(200);
  const taskId = (await created.json()).json.id as string;

  // positive control: a real canonical id resolves on the same read surface
  const read = await post(page, 'tasks/get', { taskId });
  expect(read.status()).toBe(200);
  expect((await read.json()).json.id).toBe(taskId);

  await expectStorableRefusal(page, 'tasks/get', {}, 'taskId', 'taskId');
  await expectStorableRefusal(page, 'tasks/update', { title: 'T' }, 'id', 'id');
  await expectStorableRefusal(page, 'tasks/listPaged', {}, 'projectId', 'projectId');
  await expectStorableRefusal(page, 'statuses/save', { name: 'S', position: 0 }, 'id', 'id');
  await expectStorableRefusal(
    page,
    'providers/save',
    { label: 'L', baseUrl: 'https://provider.test', endpoints: ['OPENAI-COMPLETIONS'] },
    'id',
    'id',
  );
  await expectStorableRefusal(page, 'vault/secrets/list', {}, 'folderId', 'folderId');
  await expectStorableRefusal(page, 'mcp/registryUpdate', {}, 'id', 'id');
  await expectStorableRefusal(page, 'environments/remove', {}, 'id', 'id');
  await expectStorableRefusal(
    page,
    'oidc/replace',
    { providers: [{ label: 'L', issuer: 'https://issuer.test', clientId: 'c', clientSecret: 's' }] },
    'id',
    'id',
  );
});
