// THREAD BOUNDING LAW (#175), exercised against the real server + pg:
// 1. tasks.threadList returns the NEWEST 200 visible items in {items, hasMore}
//    (status-chatter rows never thread, even inside the window);
// 2. threadOlderPage walks strictly-below the (createdAt,id) cursor until
//    hasMore=false with NO gap and NO overlap across pages;
// 3. the collected-outputs query rides task_attachments_task_idx (EXPLAIN assert
//    with enable_seqscan=off — determinism on a tiny e2e table; on prod-sized
//    data the planner picks the same index without the toggle).
import { SQL } from 'bun';

import { expect, test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';

const PAGE_CAP = 200; // server THREAD_PAGE
const VISIBLE = 205; // > one page
const STATUS_ROWS = 6; // chatter interleaved — never threads

type ThreadItem = { id: string; createdAt: string; body: string; activity: Record<string, unknown> | null };

test('thread payloads are bounded and page on demand (#175)', async ({ page }) => {
  test.setTimeout(90_000);
  // authenticated session (storageState project) + a task the cleanup fixture sweeps
  const created = await page.request.post('/rpc/tasks/create', {
    data: { json: { title: `Thread bounding E2E ${Date.now().toString(36)}` } },
  });
  expect(created.status()).toBe(200);
  const taskId = (await created.json()).json.id as string;
  expect(taskId).toBeTruthy();

  // seed: VISIBLE plain notes + STATUS_ROWS status rows, 1s apart, oldest first
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  try {
    const base = Date.parse('2026-11-01T08:00:00Z');
    const seeded: string[] = [];
    const tag = Date.now().toString(36); // retry-safe ids (cleanup sweeps between attempts)
    for (let i = 0; i < VISIBLE + STATUS_ROWS; i += 1) {
      const id = `e2e-tb-${tag}-${String(i).padStart(5, '0')}`;
      const at = new Date(base + i * 1000);
      await sql`INSERT INTO task_messages (id, task_id, body, created_at)
                VALUES (${id}, ${taskId}, ${`note ${i}`}, ${at})`;
      if (i % 35 === 0 && i < VISIBLE + STATUS_ROWS) {
        await sql`INSERT INTO task_message_activities (message_id, payload)
                  VALUES (${id}, ${JSON.stringify({ kind: 'STATUS' })}::jsonb)`;
      }
      seeded.push(id);
    }

    const callThread = async (proc: string, json: unknown) => {
      const res = await page.request.post(`/rpc/tasks/${proc}`, { data: { json } });
      expect(res.status()).toBe(200);
      return (await res.json()).json as { items: ThreadItem[]; hasMore: boolean };
    };

    // 1. newest page: capped, ascending, status-free, hasMore=true
    const first = await callThread('threadList', { taskId });
    expect(first.items).toHaveLength(PAGE_CAP);
    expect(first.hasMore).toBe(true);
    for (let i = 1; i < first.items.length; i += 1) {
      expect(first.items[i]!.createdAt >= first.items[i - 1]!.createdAt).toBe(true);
    }
    expect(first.items.every((m) => m.activity === null || m.activity.kind !== 'STATUS')).toBe(true);

    // 2. page to exhaustion — strict cursor cut, no gaps, no repeats
    const seen = new Set<string>(first.items.map((m) => m.id));
    let cursor = { createdAt: first.items[0]!.createdAt, id: first.items[0]!.id };
    let guard = 0;
    let last = first;
    while (last.hasMore && guard < 10) {
      guard += 1;
      last = await callThread('threadOlderPage', { taskId, before: cursor });
      for (const m of last.items) expect(seen.has(m.id)).toBe(false); // no overlap
      for (const m of last.items) seen.add(m.id);
      if (last.items.length > 0) cursor = { createdAt: last.items[0]!.createdAt, id: last.items[0]!.id };
    }
    expect(last.hasMore).toBe(false);
    expect(guard).toBeLessThan(10);
    // every seeded VISIBLE note threaded exactly once; status rows never did
    const statusIds = new Set(seeded.filter((_, i) => i % 35 === 0));
    const expected = seeded.filter((id) => !statusIds.has(id));
    expect(seen.size).toBe(expected.length);
    expect(expected.every((id) => seen.has(id))).toBe(true);

    // 3. the outputs scan is index-backed: same predicate shape as the service
    await sql`INSERT INTO task_messages (id, task_id, body, created_at)
              VALUES (${'e2e-tb-runmsg-' + tag}, ${taskId}, 'run', now())`;
    await sql`INSERT INTO task_runs (id, message_id, status, attempts, started_at, finished_at)
              VALUES (${'e2e-tb-run-' + tag}, ${'e2e-tb-runmsg-' + tag}, 'done', 1, now(), now())`;
    await sql`INSERT INTO task_attachments (id, task_id, run_id, kind, filename, mime, size, sha256, created_at)
              VALUES (${'e2e-tb-att-' + tag}, ${taskId}, ${'e2e-tb-run-' + tag}, 'output', 'f.bin', 'application/octet-stream', 1, 'x', now())`;
    // session toggle: deterministic index proof on a tiny table (reset in finally)
    await sql`SET enable_seqscan = off`;
    try {
      const plan = await sql`EXPLAIN (FORMAT JSON) SELECT run_id, id, filename, mime, size FROM task_attachments
        WHERE task_id = ${taskId} AND kind = 'output' AND run_id IN (${'e2e-tb-run-' + tag})`;
      const planJson = JSON.stringify(plan);
      expect(planJson).toContain('task_attachments_task_idx');
      expect(planJson).not.toContain('"Node Type": "Seq Scan"');
    } finally {
      await sql`RESET enable_seqscan`;
    }
  } finally {
    await sql.end();
  }
});
