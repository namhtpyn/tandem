// E2E: task attachments — REST upload via the app's session, token embedded in the
// description renders as inline image + file chip in the task-detail thread; the serve
// route honors etag revalidation. (The full push/collect/cleanup sandbox leg is covered
// by unit tests against the ssh seam — e2e stays DB/UI only.)
// the cleanup fixture sweeps every row the test created (tasks cascade messages/
// runs/obligations/attachments; then users, projects, environments, vault, providers)
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from './helpers/cleanup';
import { login } from './helpers/login.ts';
import { waitForHydration } from './pages/base.page.ts';
import { TasksPage } from './pages/tasks.page.ts';

// must mirror the webServer env in playwright.config.ts — same host filesystem
const ATTACHMENTS_DIR = process.env.TANDEM_E2E_ATTACHMENTS_DIR || '/tmp/tandem-e2e-attachments';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082',
  'hex',
);

test('attachment upload renders inline in the task thread', async ({ page, request, context }) => {
  const tasksPage = new TasksPage(page);
  const title = `Attachment probe ${Date.now().toString(36)}`;
  await login(page);
  await page.goto('/tasks');
  await waitForHydration(page);
  await page.getByRole('button', { name: 'New task' }).first().click();
  await page.getByPlaceholder('Task title').fill(title);
  await page.getByRole('button', { name: /Save|Create task/ }).click();
  await expect(page.getByRole('link', { name: title }).first()).toBeVisible({ timeout: 10_000 });

  await page.getByRole('link', { name: title }).first().click();
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
  await expect(page.getByText('Reference image:')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`img[src="/api/attachments/${att.id}"]`)).toBeVisible();
  await expect(page.getByRole('link', { name: /probe doc/ })).toContainText('probe doc');

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

  // teardown: the run's task must not linger in the shared DB
  await tasksPage.deleteTask(title);
});

test('task removal sweeps the attachment bytes off disk (#150)', async ({ page, context }) => {
  const tasksPage = new TasksPage(page);
  const title = `Attachment sweep ${Date.now().toString(36)}`;
  await login(page);
  await page.goto('/tasks');
  await waitForHydration(page);
  await page.getByRole('button', { name: 'New task' }).first().click();
  await page.getByPlaceholder('Task title').fill(title);
  await page.getByRole('button', { name: /Save|Create task/ }).click();
  await expect(page.getByRole('link', { name: title }).first()).toBeVisible({ timeout: 10_000 });

  await page.getByRole('link', { name: title }).first().click();
  await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 });
  const taskId = page.url().split('/').pop()!;

  const up = await context.request.post(`/api/tasks/${taskId}/attachments`, {
    multipart: { file: { name: 'sweep.png', mimeType: 'image/png', buffer: PNG } },
  });
  expect(up.status()).toBe(201);
  const att = (await up.json()) as { id: string };

  // BYTES-WITH-TASK: the bytes exist while the task does
  const bytesPath = join(ATTACHMENTS_DIR, 'tasks', taskId, 'attachments', att.id);
  expect((await stat(bytesPath)).isFile()).toBe(true);

  // remove through the real UI path — the row delete cascades and the sweep follows
  await tasksPage.deleteTask(title);

  // the attachments dir is gone, not just the one file (the parent tasks/<id> husk stays — never in the contract)
  await expect(stat(bytesPath), 'attachment bytes must be gone after tasks.remove').rejects.toThrow();
  await expect(
    stat(join(ATTACHMENTS_DIR, 'tasks', taskId, 'attachments')),
    'per-task attachments dir must be gone',
  ).rejects.toThrow();
});

test('upload route enforces the write tier + pre-parse body cap (#173)', async ({ page, context, playwright }) => {
  const tasksPage = new TasksPage(page);
  const title = `Attachment gate ${Date.now().toString(36)}`;
  await login(page);
  await page.goto('/tasks');
  await waitForHydration(page);
  await page.getByRole('button', { name: 'New task' }).first().click();
  await page.getByPlaceholder('Task title').fill(title);
  await page.getByRole('button', { name: /Save|Create task/ }).click();
  await expect(page.getByRole('link', { name: title }).first()).toBeVisible({ timeout: 10_000 });

  await page.getByRole('link', { name: title }).first().click();
  await expect(page).toHaveURL(/\/tasks\/[a-z0-9-]+/i, { timeout: 10_000 });
  const taskId = page.url().split('/').pop()!;

  // anonymous session (explicitly empty storageState — a bare newContext
  // inherits the run's signed-in storageState) -> 401
  const anon = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const r = await anon.post(`/api/tasks/${taskId}/attachments`, {
      multipart: { file: { name: 'anon.png', mimeType: 'image/png', buffer: PNG } },
    });
    expect(r.status()).toBe(401);
  } finally {
    await anon.dispose();
  }

  // body over the 21MB request cap -> 413 (the file-part check never sees it)
  const big = await context.request.post(`/api/tasks/${taskId}/attachments`, {
    multipart: { file: { name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(22 * 1024 * 1024) } },
  });
  expect(big.status()).toBe(413);

  await tasksPage.deleteTask(title);
});
