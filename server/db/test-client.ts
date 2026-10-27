// A raw postgres client that does NOT trigger the module-level DATABASE_URL
// guard in server/db/index.ts — test files import the app modules lazily after
// setting env, this one is safe to import first.
import { SQL } from 'bun';

import { templateDatabaseUrl } from '../../test/unit/worker-setup';
// env law: the test worker owns the process.env read and exports the resolved URL
const url = (globalThis as { __tandemTestUrl?: string }).__tandemTestUrl ?? templateDatabaseUrl;

export const postgres = new SQL(url, {
  max: 5,
  idleTimeout: 5,
  connectionTimeout: 10,
});
