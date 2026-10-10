// Config entry for `bunx auth generate` ONLY (the CLI needs a default export
// that builds synchronously). The runtime keeps its lazy getAuth() singleton;
// this file mirrors the plugin set so generated tables always match.
// Regenerate with: bun run gen:auth
import { betterAuth } from 'better-auth'
import { apiKey } from '@better-auth/api-key'
import { drizzle } from 'drizzle-orm/postgres-js'
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2'

export const auth = betterAuth({
  database: drizzleAdapter(drizzle('postgresql://generate:generate@127.0.0.1:1/generate', { schema: {} }), { provider: 'pg' }),
  basePath: '/auth',
  user: {
    additionalFields: {
      role: { type: ['admin', 'employee', 'viewer'] as const, required: false, defaultValue: 'viewer', input: false },
      title: { type: 'string', required: false, defaultValue: '', input: false },
    },
  },
  plugins: [
    apiKey({ enableSessionForAPIKeys: true, requireName: true, defaultPrefix: 'tandem_' }),
  ],
})
