import { expect } from '@playwright/test';
import { SQL } from 'bun';

// E2E (#174): the titles catalog save renames EVERY employee holding the old
// title (free-text column, no FK) — admin-tier per SPEC write tiers. This pins
// the admin cascade through the real router + db; the tier gate itself is
// unit-pinned (titles-tier.test.ts + rbac wiring scan). VIEWER 403 lives in
// the unit gate matrix.
import { test } from './helpers/cleanup';
import { E2E_DATABASE_URL } from './helpers/env';

// retry-safe seed rows (SQL-seed law: per-run tag, explicit created_at)
const RUN = `tt${Date.now().toString(36)}`;
const OLD_NAME = `${RUN} Legacy`;
const NEW_NAME = `${RUN} Renamed`;
const TITLE_ID = `${RUN}-title`;

test('titles.save cascades the rename onto employees (admin)', async ({ request }) => {
  const sql = new SQL(E2E_DATABASE_URL, { max: 1 });
  const userId = crypto.randomUUID();
  try {
    await sql`INSERT INTO employee_titles (id, name, created_at, updated_at) VALUES (${TITLE_ID}, ${OLD_NAME}, now(), now())`;
    await sql`INSERT INTO "user" (id, name, email, role, title, created_at, updated_at)
              VALUES (${userId}, ${'Titles Cascade'}, ${`${RUN}@tandem.test`}, 'VIEWER', ${OLD_NAME}, now(), now())`;

    const res = await request.post('/rpc/employees/titles/save', { data: { json: { id: TITLE_ID, name: NEW_NAME } } });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ json: { id: TITLE_ID } });

    const rows = await sql`SELECT title FROM "user" WHERE id = ${userId}`;
    expect(rows[0]!.title).toBe(NEW_NAME);
    const catalog = await sql`SELECT name FROM employee_titles WHERE id = ${TITLE_ID}`;
    expect(catalog[0]!.name).toBe(NEW_NAME);
  } finally {
    // employee_titles is NOT in the shared sweep — clean both inline
    await sql`DELETE FROM "user" WHERE id = ${userId}`;
    await sql`DELETE FROM employee_titles WHERE id = ${TITLE_ID}`;
  }
});
