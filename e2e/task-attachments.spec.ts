// E2E: task attachments — REST upload via the app's session, token embedded in the
// description renders as inline image + file chip in the task-detail thread; the serve
// route honors etag revalidation. (The full push/collect/cleanup sandbox leg is covered
// by unit tests against the ssh seam — e2e stays DB/UI only.)
import { expect, test } from '@playwright/test';

import { login } from './helpers/login';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082',
  'hex',
);

test('attachment upload renders inline in the task thread', async ({ page, request, context }) => {
  await login(page);
  await page.goto('/tasks');
  await page.getByRole('button', { name: 'New task' }).first().click();
  await page.getByPlaceholder('Task title').fill('Attachment probe');
  await page.getByRole('button', { name: /Save|Create task/ }).click();
  await page.waitForTimeout(800);

  await page.getByRole('link', { name: 'Attachment probe' }).first().click();
  await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 });
  const taskId = page.url().split('/').pop()!;

  // upload through the REST route with the browser session
  const up = await context.request.post(`/api/tasks/${taskId}/attachments`, {
    multipart: { file: { name: 'probe.png', mimeType: 'image/png', buffer: PNG } },
  });
  expect(up.status()).toBe(201);
  const att = (await up.json()) as { id: string; filename: string; mime: string };

  // embed the token in the description
  const upd = await page.evaluate(
    async ({ taskId, attId }) => {
      const r = await fetch('/rpc/tasks/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          json: {
            id: taskId,
            description: `Reference image: ![probe](attachment-${attId}) and doc @[probe doc](attachment-${attId})`,
          },
        }),
      });
      return r.status;
    },
    { taskId, attId: att.id },
  );
  expect(upd).toBe(200);

  // thread renders the image + the file chip
  await page.reload();
  await page.waitForSelector('text=Reference image:', { timeout: 10_000 });
  await expect(page.locator(`img[src="/api/attachments/${att.id}"]`)).toBeVisible();
  await expect(page.getByRole('link', { name: /probe doc/ })).toBeVisible();

  // serve route: etag present and 304 on revalidation
  const first = await context.request.get(`/api/attachments/${att.id}`);
  expect(first.status()).toBe(200);
  const etag = first.headers()['etag'];
  expect(etag).toBeTruthy();
  const reval = await context.request.get(`/api/attachments/${att.id}`, { headers: { 'if-none-match': etag! } });
  expect(reval.status()).toBe(304);

  // disallowed type is rejected
  const bad = await context.request.post(`/api/tasks/${taskId}/attachments`, {
    multipart: { file: { name: 'x.sh', mimeType: 'application/x-sh', buffer: Buffer.from('rm -rf /') } },
  });
  expect(bad.status()).toBe(415);
});
