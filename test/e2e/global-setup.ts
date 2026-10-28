import { SQL } from 'bun';

import { E2E_DATABASE_URL, redactedDatabaseUrl } from './helpers/env';
// E2E reset: every run starts from a fresh data set. The web server is booted by
// Playwright BEFORE this hook (webServer is a plugin setup task), so migrations
// have applied and the boot admin exists.
//
// Kept: `user` + `account` (the boot admin and its credential login — boot only
// seeds an admin when the user table is EMPTY, so truncating them would leave a
// loginless instance).
//
// `settings` is truncated: every consumer has a code default, and a value a
// previous run wrote is poison (tasks_per_agent, OIDC providers, …).
// `task_statuses` is RE-SEEDED to the baseline migration rows, not kept: keeping
// it preserved custom statuses and edited transitions from earlier runs forever.
const KEEP = new Set(['user', 'account', 'task_statuses']);

/** the baseline seed rows (drizzle/20261026054027_baseline + blocked_edges). */
const SEED_STATUSES: Array<{
  id: string;
  name: string;
  color: string;
  position: number;
  category: string;
  nextIds: string[];
}> = [
  {
    id: '01a14743-43f4-7053-a698-5b4ef36ed046',
    name: 'To do',
    color: 'neutral',
    position: 0,
    category: 'ready',
    nextIds: ['01a14743-43f5-759d-a00e-9ccda502cc88', '01a14743-43f5-759d-a00e-b0f2a5a04f4c'],
  },
  {
    id: '01a14743-43f5-759d-a00e-9ccda502cc88',
    name: 'Doing',
    color: 'warning',
    position: 1,
    category: 'working',
    nextIds: [
      '01a14743-43f4-7053-a698-5b4ef36ed046',
      '01a14743-43f5-759d-a00e-a424b478f2fa',
      '01a14743-43f5-759d-a00e-a90831248ea5',
      '01a14743-43f5-759d-a00e-a20a36faa315',
      '01a14743-43f5-759d-a00e-ada27e46c2f8',
    ],
  },
  {
    id: '01a14743-43f5-759d-a00e-a20a36faa315',
    name: 'Done',
    color: 'success',
    position: 2,
    category: 'done',
    nextIds: ['01a14743-43f5-759d-a00e-9ccda502cc88'],
  },
  {
    id: '01a14743-43f5-759d-a00e-a424b478f2fa',
    name: 'Waiting answer',
    color: 'warning',
    position: 3,
    category: 'waiting_answer',
    nextIds: ['01a14743-43f5-759d-a00e-9ccda502cc88'],
  },
  {
    id: '01a14743-43f5-759d-a00e-a90831248ea5',
    name: 'In review',
    color: 'info',
    position: 4,
    category: 'in_review',
    nextIds: ['01a14743-43f5-759d-a00e-9ccda502cc88', '01a14743-43f5-759d-a00e-a20a36faa315'],
  },
  {
    id: '01a14743-43f5-759d-a00e-ada27e46c2f8',
    name: 'Blocked',
    color: 'error',
    position: 5,
    category: 'paused',
    nextIds: ['01a14743-43f4-7053-a698-5b4ef36ed046', '01a14743-43f5-759d-a00e-b0f2a5a04f4c'],
  },
  {
    id: '01a14743-43f5-759d-a00e-b0f2a5a04f4c',
    name: 'Cancelled',
    color: 'neutral',
    position: 6,
    category: 'cancelled',
    nextIds: [],
  },
];

/** tables a working e2e run cannot do without — asserted after migrate so a
 *  half-booted schema fails HERE with a clear message, not in a random spec */
const REQUIRED_TABLES = [
  'user',
  'account',
  'settings',
  'task_statuses',
  'tasks',
  'task_messages',
  'task_runs',
  'task_obligations',
  'task_attachments',
];

export default async function globalSetup() {
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  try {
    // fail fast: a wrong port/database here used to surface as dozens of
    // unrelated login/locator timeouts inside the specs
    try {
      await sql`select 1`;
    } catch (e) {
      throw new Error(
        `e2e database unreachable at ${redactedDatabaseUrl()} — start the container or set TANDEM_E2E_DATABASE_URL (${e instanceof Error ? e.message : String(e)})`,
      );
    }

    const tables = (await sql`
      select tablename from pg_tables where schemaname = 'public' order by tablename
    `) as Array<{ tablename: string }>;
    const present = new Set(tables.map((t) => t.tablename));
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    if (missing.length) {
      throw new Error(`e2e schema is not migrated — missing tables: ${missing.join(', ')}`);
    }

    const names = [...present].filter((name) => !KEEP.has(name));
    if (names.length) {
      const list = names.map((name) => `public."${name.replaceAll('"', '""')}"`).join(', ');
      await sql.unsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    }

    // baseline statuses only: custom rows + edited transitions from earlier runs
    // must not leak into the next suite (tests create their own custom statuses)
    await sql`delete from task_statuses`;
    for (const s of SEED_STATUSES) {
      await sql`
        insert into task_statuses (id, name, color, position, category, next_ids, created_at, updated_at)
        values (${s.id}, ${s.name}, ${s.color}, ${s.position}, ${s.category}, ${sql.array(s.nextIds)}, now(), now())
      `;
    }
  } finally {
    await sql.close();
  }
}
