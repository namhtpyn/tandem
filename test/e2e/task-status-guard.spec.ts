// the cleanup fixture sweeps every row the test created (tasks cascade messages/
// runs/obligations/attachments; then users, projects, environments, vault, providers)
import { expect, test } from './helpers/cleanup';
import { login } from './helpers/login.ts';

// Regression guard for the ghost-row incident (issue #62): tasks.status has no FK
// by design (status deletes re-home their tasks), so the WRITE path is the gate —
// tasks.setStatus once accepted any non-empty string, and a legacy semantic string
// ('doing') that survived the uuid remap turned a task invisible to dispatch +
// board (inner-join on task_statuses drops it). Every status write must reference
// a seeded task_statuses id; the teardown/resume branches uuid-compare, so this
// also keeps manual settles verdicts-of-record instead of silently skipping them.

type StatusRow = { id: string; name: string; category: string };
type TaskRow = { id: string; status: string };

test('setStatus rejects status values that are not seeded status ids', async ({ page }) => {
  await login(page);

  // seeded status ids (plain first-load list)
  const statusesRes = await page.request.post('/rpc/statuses/list', { data: { json: null } });
  expect(statusesRes.status()).toBe(200);
  const statuses = ((await statusesRes.json()).json ?? []) as StatusRow[];
  const ready = statuses.find((s) => s.category === 'ready');
  const working = statuses.find((s) => s.category === 'working');
  const done = statuses.find((s) => s.category === 'done');
  expect(ready).toBeTruthy();
  expect(working).toBeTruthy();
  expect(done).toBeTruthy();

  // task created via RPC lands in the first ready status (resolveCreatedStatus)
  const created = await page.request.post('/rpc/tasks/create', {
    data: { json: { title: `Status guard E2E ${Date.now().toString(36)}` } },
  });
  expect(created.status()).toBe(200);
  const taskId = (await created.json()).json.id as string;
  expect(taskId).toBeTruthy();

  const statusOf = async (): Promise<string> => {
    const res = await page.request.post('/rpc/tasks/list', { data: { json: null } });
    expect(res.status()).toBe(200);
    const rows = ((await res.json()).json ?? []) as TaskRow[];
    return rows.find((r) => r.id === taskId)!.status;
  };
  expect(await statusOf()).toBe(ready!.id);

  // legacy semantic string — the exact re-entry shape from the incident → 400, row untouched
  const bad = await page.request.post('/rpc/tasks/setStatus', {
    data: { json: { id: taskId, status: 'doing' } },
  });
  expect(bad.status()).toBe(400);
  expect(JSON.stringify(await bad.json())).toContain('status does not exist');
  expect(await statusOf()).toBe(ready!.id);

  // valid seeded uuid moves still work
  const ok = await page.request.post('/rpc/tasks/setStatus', {
    data: { json: { id: taskId, status: working!.id } },
  });
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toMatchObject({ json: { ok: true } });
  expect(await statusOf()).toBe(working!.id);

  // terminal settle via a valid uuid still passes the guard (teardown path reachable —
  // manual done stays the verdict of record; no open round here, teardown is a no-op)
  const settle = await page.request.post('/rpc/tasks/setStatus', {
    data: { json: { id: taskId, status: done!.id } },
  });
  expect(settle.status()).toBe(200);
  expect(await settle.json()).toMatchObject({ json: { ok: true } });
  expect(await statusOf()).toBe(done!.id);
});
