// env contract report formatting — the boot failure output humans read
import { describe, expect, it } from 'vitest';
import { formatEnvIssues } from '../server/domains/kernel/env';

describe('formatEnvIssues', () => {
  it('missing required vars read "LABEL is required"', () => {
    const out = formatEnvIssues([{ path: ['DATABASE_URL'], message: 'Invalid input: expected string, received undefined' }]);
    expect(out).toContain('DATABASE_URL is required');
  });

  it('keeps zod messages for invalid values', () => {
    const out = formatEnvIssues([{ path: ['TANDEM_VAULT_KEY'], message: 'must decode to 32 bytes (openssl rand -base64 32)' }]);
    expect(out).toContain('TANDEM_VAULT_KEY: must decode to 32 bytes');
  });

  it('joins multiple issues one per line', () => {
    const out = formatEnvIssues([
      { path: ['A'], message: 'Invalid input: expected string, received undefined' },
      { path: ['B'], message: 'bad' },
    ]);
    expect(out.split('\n')).toHaveLength(2);
    expect(out).toContain('A is required');
    expect(out).toContain('B: bad');
  });
});
