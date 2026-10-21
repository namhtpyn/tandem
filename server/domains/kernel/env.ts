// Boot-time env contract — validated ONCE at first import, fail fast with a
// single report. Services read the typed `env` object, never process.env.
// Test-only knobs (TANDEM_FAKE_*, TANDEM_TEST_DATABASE_URL) stay dynamic on
// purpose: tests mutate them per-suite before their own imports.
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  TANDEM_VAULT_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must decode to 32 bytes (openssl rand -base64 32)'),
  REDIS_URL: z.string().url().optional(),
  TANDEM_PUBLIC_URL: z.string().url().optional(),
  TANDEM_ATTACHMENTS_DIR: z.string().optional(),
  TANDEM_DRIZZLE_DIR: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().optional(),
  BETTER_AUTH_URL: z.string().url().optional(),
  TANDEM_DISABLE_PASSWORD_LOGIN: z.string().optional(),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),
});

const parsed = envSchema.safeParse({
  DATABASE_URL: process.env.DATABASE_URL,
  TANDEM_VAULT_KEY: process.env.TANDEM_VAULT_KEY,
  REDIS_URL: process.env.REDIS_URL || undefined,
  TANDEM_PUBLIC_URL: process.env.TANDEM_PUBLIC_URL || undefined,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET || undefined,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL || undefined,
  TANDEM_DISABLE_PASSWORD_LOGIN: process.env.TANDEM_DISABLE_PASSWORD_LOGIN || undefined,
  TANDEM_ATTACHMENTS_DIR: process.env.TANDEM_ATTACHMENTS_DIR || undefined,
  TANDEM_DRIZZLE_DIR: process.env.TANDEM_DRIZZLE_DIR || undefined,
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || undefined,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || undefined,
});

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('[tandem] invalid environment:\n' + parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}

export const env = parsed.data;
