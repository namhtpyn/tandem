// THREAD BOUNDING LAW (#175): thread payloads are bounded pages, never fetch-alls —
// the newest page caps at THREAD_PAGE visible items with hasMore covering BOTH
// truncation sources (visible-cap tail + raw-window overflow); older history travels
// only through threadOlderPage on the (createdAt,id) cursor; the above-cursor echo
// pairing context never threads itself; the outputs scan is task-scoped (task_id
// predicate, dead run_id IS NULL arm gone) and the runs snapshot caps at 50.
import { drizzle } from 'drizzle-orm/bun-sql';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { taskAttachments } from '../../server/db/schema';

const h = vi.hoisted(() => ({
  // scripted RQB answers, keyed by call shape: scan (no columns) vs probes (columns)
  scans: [] as Array<Record<string, unknown>>,
  scanRows: [] as Array<Array<Record<string, unknown>>>,
  olderProbeRows: [] as Array<Array<Record<string, unknown>>>,
  contextRows: [] as Array<Array<Record<string, unknown>>>,
  outputConds: [] as Array<unknown>,
  userRows: [] as Array<Array<Record<string, unknown>>>,
}));

function classify(args: Record<string, unknown>) {
  if (args.columns && args.limit === 1) return 'probe';
  if (args.columns) return 'context';
  return 'scan';
}

vi.mock('../../server/db/index', () => ({
  asDb: (x: unknown) => x,
  db: {
    query: {
      taskMessages: {
        findMany: async (args: Record<string, unknown>) => {
          const kind = classify(args);
          if (kind === 'scan') {
            h.scans.push(args);
            return h.scanRows.shift() ?? [];
          }
          if (kind === 'probe') return h.olderProbeRows.shift() ?? [];
          return h.contextRows.shift() ?? [];
        },
      },
      user: { findMany: async () => h.userRows.shift() ?? [] },
    },
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          h.outputConds.push(cond);
          return Promise.resolve([]);
        },
      }),
    }),
  },
}));

vi.mock('../../server/domains/tasks/run-transcript', () => ({
  loadTranscriptBits: async () => new Map(),
  transcriptSnapshotColumns: () => ({}),
}));

// runner.service's module graph: kernel env/publish/queue + settings must not boot
vi.mock('../../server/domains/kernel/env', () => ({
  env: { TANDEM_VAULT_KEY: Buffer.alloc(32, 7).toString('base64') },
}));
vi.mock('../../server/domains/kernel/kernel', () => ({ publishChange: async () => undefined }));
vi.mock('../../server/domains/kernel/queue', () => ({ redisQueue: {} }));
vi.mock('../../server/domains/settings/settings.service', () => ({ getRunTimeoutMs: async () => 60_000 }));

// imports AFTER the mocks (vitest hoists vi.mock above static imports)
const { listTaskThread, threadOlderPage, THREAD_PAGE, THREAD_RAW_WINDOW } =
  await import('../../server/domains/tasks/thread.service');
const { RUNS_SNAPSHOT_CAP, runsListScan } = await import('../../server/domains/tasks/runner.service');

type Msg = Record<string, unknown>;
let seq = 0;
function msg(over: Partial<Msg> = {}): Msg {
  seq += 1;
  return {
    id: `m-${String(seq).padStart(4, '0')}`,
    taskId: 'task-1',
    authorId: 'u1',
    body: `body ${seq}`,
    createdAt: new Date(Date.parse('2026-11-01T10:00:00Z') + seq * 1000),
    author: { name: 'Unit' },
    run: null,
    activityExt: null,
    ...over,
  };
}

function page(rows: Msg[]) {
  // the real scan is (createdAt,id) DESC — the fake answers newest-first like it
  const desc = [...rows].reverse();
  h.scanRows.push(desc);
  h.olderProbeRows.push([]);
  h.contextRows.push([]);
}

beforeEach(() => {
  seq = 0;
  h.scans.length = 0;
  h.scanRows.length = 0;
  h.olderProbeRows.length = 0;
  h.contextRows.length = 0;
  h.outputConds.length = 0;
  h.userRows.length = 0;
});

describe('thread bounding (#175)', () => {
  it('caps the newest page at THREAD_PAGE visible items, newest tail, hasMore=true on the visible cap', async () => {
    const total = THREAD_PAGE + 50;
    page(Array.from({ length: total }, () => msg()));
    const out = await listTaskThread('task-1');
    expect(out.items).toHaveLength(THREAD_PAGE);
    expect(out.items[0].body).toBe(`body ${total - THREAD_PAGE + 1}`); // oldest SURVIVOR
    expect(out.items.at(-1)?.body).toBe(`body ${total}`); // newest
    expect(out.hasMore).toBe(true);
    // single bounded raw scan, newest-first
    expect(h.scans).toHaveLength(1);
    expect(h.scans[0].limit).toBe(THREAD_RAW_WINDOW);
    expect(h.scans[0].orderBy).toEqual({ createdAt: 'desc', id: 'desc' });
  });

  it('reports hasMore=false for a thread inside the page cap', async () => {
    page(Array.from({ length: 5 }, () => msg()));
    const out = await listTaskThread('task-1');
    expect(out.items).toHaveLength(5);
    expect(out.hasMore).toBe(false);
  });

  it('probes for raw rows beyond a FULL raw window to decide hasMore', async () => {
    page(Array.from({ length: THREAD_RAW_WINDOW }, () => msg()));
    // 600 raw -> 600 visible > page cap; the probe is consumed only in the
    // short-circuit OR's second arm — visible-cap already decides true here
    const out = await listTaskThread('task-1');
    expect(out.hasMore).toBe(true);

    // a FULL window whose visible set stays under the cap must consult the probe
    h.scans.length = 0;
    h.scanRows.length = 0;
    h.olderProbeRows.length = 0;
    const quiet: Msg[] = [];
    for (let i = 0; i < THREAD_RAW_WINDOW; i += 1) {
      // status rows are filtered out; keep a handful visible so the cap never trips
      quiet.push(msg({ activityExt: i % 20 === 0 ? null : { payload: JSON.stringify({ kind: 'status' }) } }));
    }
    h.scanRows.push(quiet);
    h.olderProbeRows.push([msg()]); // an older raw row exists
    const out2 = await listTaskThread('task-1');
    expect(out2.hasMore).toBe(true);
    expect(out2.items.length).toBeGreaterThan(0);

    h.olderProbeRows.push([]); // nothing beyond the window
    h.scanRows.push(quiet.map((m) => ({ ...m, id: `${m.id}-b` })));
    const out3 = await listTaskThread('task-1');
    expect(out3.hasMore).toBe(false);
  });

  it('pages older history strictly below the (createdAt,id) cursor, asc, with in-window echo pairing', async () => {
    const cursor = { createdAt: '2026-11-01T10:00:30.000Z', id: 'm-0030' };
    const runRow = msg({
      id: 'm-0019',
      createdAt: new Date(Date.parse('2026-11-01T10:00:19Z')),
      body: 'settled result',
      run: {
        id: 'run-1',
        status: 'done',
        exitCode: 0,
        startedAt: new Date(),
        finishedAt: new Date(),
        employeeId: 'a1',
      },
    });
    // the echo trails its OWN run inside the same window -> dropped window-locally
    const echo = msg({
      id: 'm-0020',
      body: 'settled result',
      createdAt: new Date(Date.parse('2026-11-01T10:00:19.500Z')),
    });
    const below = [
      runRow,
      echo,
      ...Array.from({ length: 8 }, (_, i) =>
        msg({
          id: `m-${String(18 - i).padStart(4, '0')}`,
          createdAt: new Date(Date.parse('2026-11-01T10:00:18Z') - i * 1000),
        }),
      ),
    ];
    const descWindow = [...below].sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime());
    h.scanRows.push(descWindow); // newest-first like the real desc scan
    h.olderProbeRows.push([]);

    const out = await threadOlderPage('task-1', cursor);
    const ids = out.items.map((m: { id: string }) => m.id);
    expect(ids).not.toContain(echo.id as string); // echo paired with its in-window run
    expect(out.items.every((m: { createdAt: string }) => m.createdAt < cursor.createdAt)).toBe(true); // strict cursor cut
    // ascending order
    const times = out.items.map((m: { createdAt: string }) => m.createdAt);
    expect([...times].sort()).toEqual(times);
    // the scan cut is the cursor tuple (OR of createdAt-lt / createdAt-eq+id-lt)
    const scan = h.scans[0] as { where: { OR: Array<Record<string, unknown>> } };
    expect(scan.where.OR).toHaveLength(2);
  });

  it('scopes the outputs scan to the task and drops the dead IS NULL arm (#175)', async () => {
    page([
      msg({
        run: {
          id: 'run-1',
          status: 'done',
          exitCode: 0,
          startedAt: new Date(),
          finishedAt: new Date(),
          employeeId: 'a1',
        },
      }),
    ]);
    await listTaskThread('task-1');
    expect(h.outputConds).toHaveLength(1);

    // render the captured condition through a real drizzle dialect and inspect the SQL
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sql = (drizzle.mock() as any).select().from(taskAttachments).where(h.outputConds[0]).toSQL();
    expect(sql.sql).toContain('"task_id" = ');
    expect(sql.sql).toContain('"kind" = ');
    expect(sql.sql).toContain('in (');
    expect(sql.sql).not.toContain('is null');
  });

  it('caps the runs snapshot scan at RUNS_SNAPSHOT_CAP, newest-first', async () => {
    expect(RUNS_SNAPSHOT_CAP).toBe(50);
    // runsListScan(ex) composes on the injected executor — a chain-recording fake
    // pins the composed shape (limit + newest-first order) without a live db
    const calls: Array<[string, unknown[]]> = [];
    const builder: Record<string, unknown> = {
      select: () => builder,
      from: () => builder,
      innerJoin: () => builder,
      where: () => builder,
      orderBy: (...o: unknown[]) => {
        calls.push(['orderBy', o]);
        return builder;
      },
      limit: (n: number) => {
        calls.push(['limit', [n]]);
        return builder;
      },
      // thenable: the scan awaits the builder directly in caller code
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve([]).then(res, rej),
    };
    const out = await runsListScan(builder as never, 'task-1');
    expect(out).toEqual([]);
    expect(calls.find(([name]) => name === 'limit')?.[1]).toEqual([RUNS_SNAPSHOT_CAP]);
    const order = calls.find(([name]) => name === 'orderBy')?.[1] ?? [];
    expect(order).toHaveLength(2); // startedAt desc, id desc
  });
});
