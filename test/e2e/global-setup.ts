import { SQL } from 'bun';

// E2E reset: every run starts from a fresh data set. The web server is booted
// by Playwright BEFORE this hook (webServer is a plugin setup task), so the
// schema is already migrated and the boot admin exists — we truncate the data
// tables and keep only what boot/migrations seed.
//
// Kept: `user` + `account` (the boot admin and its credential login),
// `settings` (workspace defaults), `task_statuses` (seeded by the baseline
// migration — re-running migrations would need a full rebuild).
const KEEP = new Set(['user', 'account', 'settings', 'task_statuses']);

const DATABASE_URL = process.env.TANDEM_E2E_DATABASE_URL ?? 'postgresql://tandem:tandem@127.0.0.1:55432/tandem_e2e';

export default async function globalSetup() {
  const sql = new SQL(DATABASE_URL, { max: 1 });
  try {
    const tables = (await sql`
      select tablename from pg_tables where schemaname = 'public' order by tablename
    `) as Array<{ tablename: string }>;
    const names = tables.map((t) => t.tablename).filter((name) => !KEEP.has(name));
    if (!names.length) return;
    const list = names.map((name) => `public."${name.replaceAll('"', '""')}"`).join(', ');
    await sql.unsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  } finally {
    await sql.close();
  }
}
