// official driver-less drizzle: typed db + toSQL for query-shape unit tests;
// execute() throws by design — anything executing belongs in test/integration
import { drizzle } from 'drizzle-orm/bun-sql';

import { installRqbExtensions } from '#server/db/rqb-extensions';
import { relations } from '#server/db/schema';

export function mockDb() {
  const db = drizzle.mock({ relations });
  // same extensions prod installs (count / findManyAndCount on db.query)
  installRqbExtensions(db.query);
  return db;
}
