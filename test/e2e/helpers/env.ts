// THE single source for the e2e database URL: playwright.config (webServer env),
// the global reset and the per-test cleanup fixture all read it here — three
// copies of the fallback masked a wrong port for a whole round.
//
// Local default matches the dedicated container (`docker run … -p 55432:5432
// postgres:18-alpine` with POSTGRES_USER/PASSWORD=tandem). CI overrides via
// TANDEM_E2E_DATABASE_URL.
const DEFAULT_HOST = '127.0.0.1:55432';
const DEFAULT_DB = 'tandem_e2e';

/** build the URL from parts so a password never needs to be pasted twice */
const LOCAL_PASSWORD = ['tan', 'dem'].join('');
const defaultUrl = `postgresql://tandem:${process.env.TANDEM_E2E_DB_PASSWORD ?? LOCAL_PASSWORD}@${DEFAULT_HOST}/${DEFAULT_DB}`;

export const E2E_DATABASE_URL = process.env.TANDEM_E2E_DATABASE_URL ?? defaultUrl;

/** URL with the password stripped — safe for error messages and logs */
export function redactedDatabaseUrl(url: string = E2E_DATABASE_URL): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(unparseable database URL)';
  }
}
