// Boot-time env contract — validated ONCE at first import, fail fast with a
// single report. Parsed with safeParseAsync (top-level await) so async
// refinements slot in later without touching consumers. Services read the
// typed `env` object, never process.env. Test-only knobs (TANDEM_FAKE_*,
// TANDEM_TEST_DATABASE_URL) stay dynamic on purpose: tests mutate them
// per-suite before their own imports.
import { z } from 'zod';

// env vars arrive as strings — '' means "unset" for every field
const envSchema = z.preprocess(
  (raw) => Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v !== '')),
  z.object({
  DATABASE_URL: z.url(),
  TANDEM_VAULT_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must decode to 32 bytes (openssl rand -base64 32)'),
  REDIS_URL: z.url(),
  TANDEM_PUBLIC_URL: z.url().optional(),
  TANDEM_ATTACHMENTS_DIR: z.string().optional(),
  TANDEM_DRIZZLE_DIR: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().optional(),
  BETTER_AUTH_URL: z.url().optional(),
  TANDEM_DISABLE_PASSWORD_LOGIN: z.string().optional(),
  ADMIN_EMAIL: z.email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),
  }),
);

const parsed = await envSchema.safeParseAsync(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('[tandem] invalid environment:\n' + parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}

export const env = parsed.data;
