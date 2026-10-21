import { apiKey } from '@better-auth/api-key';
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2';
// Config entry for `bunx auth generate` ONLY (the CLI needs a default export
// that builds synchronously). The runtime keeps its lazy getAuth() singleton;
// this file mirrors the plugin set so generated tables always match.
// Regenerate with: bun run gen:auth
import { betterAuth } from 'better-auth';
import { v7 as uuidv7 } from 'uuid';
// `bunx auth` loads this file under node/jiti — drizzle-orm/bun-sql imports the
// `bun` builtin there and dies. Generate never queries; an inert handle is enough.
const inertDb = {} as never;
export const auth = betterAuth({
  database: drizzleAdapter(inertDb, { provider: 'pg' }),
  advanced: { database: { generateId: 'uuid' } },
  basePath: '/auth',
  user: {
    additionalFields: {
      role: { type: ['ADMIN', 'EMPLOYEE', 'VIEWER'] as const, required: false, defaultValue: 'VIEWER', input: false }, // stored values are SCREAMING (enum law)
      title: { type: 'string', required: false, defaultValue: '', input: false },
    },
  },
  plugins: [apiKey({ enableSessionForAPIKeys: true, requireName: true, defaultPrefix: 'tandem_' })],
});
