// Boot-time env contract — validated ONCE at first import, fail fast with a
// single report. Parsed with safeParseAsync (top-level await) so async
// refinements slot in later without touching consumers. `env` is the ONLY
// way app code sees configuration: services import this object, never
// process.env (the sole allowed read is the safeParseAsync call below).
// Tests mutate knobs after boot via setEnv — never process.env.
import { consola } from 'consola';
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
    APP_VERSION: z.string().optional(),
    // runtime knobs — read lazily at call sites so setEnv() lands
    TANDEM_NO_DISPATCHER: z.string().optional(),
    TANDEM_RUN_FLUSH_MS: z.string().optional(),
    TANDEM_ACP_CANCEL_GRACE_MS: z.string().optional(),
    TANDEM_SSH_TIMEOUT_MS: z.string().optional(),
    // boot-time knob — the pool is built once at import, so the contract (not a
    // process.env bypass) validates it: an unset/0/NaN pool dies at boot, not at query
    TANDEM_DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    // fake-runner knobs (test-only)
    TANDEM_FAKE_RUNNER: z.string().optional(),
    TANDEM_FAKE_SCRIPT: z.string().optional(),
    TANDEM_FAKE_SCRIPT_REVIEW: z.string().optional(),
    TANDEM_FAKE_FAIL: z.string().optional(),
    TANDEM_FAKE_DELAY_MS: z.string().optional(),
    // static OIDC fallback (DB-configured providers take precedence)
    TANDEM_OIDC_ISSUER: z.url().optional(),
    TANDEM_OIDC_CLIENT_ID: z.string().optional(),
    TANDEM_OIDC_CLIENT_SECRET: z.string().optional(),
    TANDEM_OIDC_LABEL: z.string().optional(),
  }),
);

/** exit-gate: any failed parse = one report + exit 1 (spied in tests, real in boot) */
export function assertEnv(
  parsed: { success: true; data: Env } | { success: false; error: { issues: EnvIssue[] } },
): asserts parsed is { success: true; data: Env } {
  /* v8 ignore next 1 -- per-test module copies + last-copy-wins merging hide the spied run; behavior pinned by env-contract tests */
  if (!parsed.success) reportInvalidEnvironment(parsed.error.issues);
}

const parsed = await envSchema.safeParseAsync(process.env);
assertEnv(parsed);

export type EnvIssue = { path: (string | number | symbol)[]; message: string };

/** one fail-fast report then exit — the negative boot tests exercise this via child processes */
export function reportInvalidEnvironment(issues: EnvIssue[]): never {
  consola.error('[tandem] invalid environment:\n' + formatEnvIssues(issues));
  process.exit(1);
}

/** one human-readable line per invalid env var — "LABEL is required" for missing, zod's message otherwise */
export function formatEnvIssues(issues: EnvIssue[]) {
  return issues
    .map((i) => {
      const label = i.path.join('.') || 'env';
      // a stripped empty string reads as "expected string, received undefined" — say "is required"
      return i.message.includes('received undefined') ? `  ${label} is required` : `  ${label}: ${i.message}`;
    })
    .join('\n');
}

export type Env = z.infer<typeof envSchema>;

// one env instance per process — vi.resetModules() re-evaluates this module,
// and tests patch the object via setEnv AFTER boot; a re-parse must not
// discard those patches, so the object survives module re-evaluation.
const g = globalThis as typeof globalThis & { __tandemEnv?: Env };
g.__tandemEnv ??= parsed.data;

export const env = g.__tandemEnv;

/** TEST-ONLY: override knobs after boot (env is frozen at first import otherwise). */
export function setEnv(patch: Partial<Env>) {
  Object.assign(env, patch);
}
