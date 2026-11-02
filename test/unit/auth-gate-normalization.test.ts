// Auth policy gates must match the ROUTER's path shape, not the raw url
// (audit #251, SPEC §Auth "sign-up is closed after any user exists"). Nitro
// handlers get the raw url, but better-auth routes on the WHATWG-normalized
// pathname — `new URL(...).pathname` collapses /./, /../ and percent-encoded
// dot segments (/auth/sign-up/%2e%2e/sign-up/email). Gating on raw-string
// includes() let those shapes bypass the closure gate while the endpoint
// still served: anonymous account creation on a closed instance. Pinned here:
// the normalizer truth table + route-level 403s for every bypass shape.
import { createEvent, type H3Event } from 'h3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { anyUserExists, getAuth, resolveAuthPolicy } from '#server/domains/auth/auth.service';
import { normalizedAuthPath } from '#server/domains/kernel/request-path';
import authHandler from '#server/routes/auth/[...].ts';

vi.mock('#server/domains/auth/auth.service', () => ({
  anyUserExists: vi.fn(async () => true),
  resolveAuthPolicy: vi.fn(async () => ({ passwordEnabled: false, oidcEnabled: false })),
  getAuth: vi.fn(async () => {
    throw new Error('SENTINEL-gate-passed');
  }),
}));

function fakeEvent(method: string, url: string): H3Event {
  const req = {
    headers: { 'content-type': 'application/json', 'content-length': '0' },
    method,
    url,
  };
  const res = { headersSent: false, statusCode: 200 } as never;
  const event = createEvent(req as never, res);
  return event;
}

beforeEach(() => {
  vi.mocked(anyUserExists).mockClear();
  vi.mocked(getAuth).mockClear();
});

describe('normalizedAuthPath — mirrors the router pathname shape', () => {
  it('plain path passes through, query stripped', () => {
    expect(normalizedAuthPath('/auth/sign-up/email?x=1')).toBe('/auth/sign-up/email');
  });

  it('single-dot segment collapses (the #251 bypass shape)', () => {
    expect(normalizedAuthPath('/auth/sign-up/./email')).toBe('/auth/sign-up/email');
  });

  it('double-dot segment collapses', () => {
    expect(normalizedAuthPath('/auth/x/../sign-up/email')).toBe('/auth/sign-up/email');
  });

  it('percent-encoded double-dot collapses (WHATWG dot-segment rule)', () => {
    expect(normalizedAuthPath('/auth/sign-up/%2e%2e/sign-up/email')).toBe('/auth/sign-up/email');
  });

  it('double slashes are PRESERVED (router parity: better-auth 404s these, so a gate skip is safe)', () => {
    expect(normalizedAuthPath('//auth//sign-up/email')).toBe('//auth//sign-up/email');
  });

  it('hostile/unparseable input never throws and never gate-serves', () => {
    for (const u of ['http://[::', '//[::', 'http://x:99999/', ' ', '%']) {
      const p = normalizedAuthPath(u);
      expect(p).not.toMatch(/^\/auth\/(sign-up|sign-in|oauth2)/);
    }
  });
});

describe('auth route gates on the normalized path', () => {
  it.each([
    '/auth/sign-up/email',
    '/auth/sign-up/./email',
    '/auth/sign-up/x/../sign-up/email',
    '/auth/sign-up/%2e%2e/sign-up/email',
    '/auth/sign-up/email/',
  ])('closed instance: POST %s -> 403 before any body read', async (url) => {
    await expect(authHandler(fakeEvent('POST', url))).rejects.toMatchObject({
      statusCode: 403,
      statusMessage: 'sign-up is closed',
    });
    expect(vi.mocked(getAuth)).not.toHaveBeenCalled();
  });

  it('empty instance: sign-up gate passes through (sentinel from getAuth, not a 403)', async () => {
    vi.mocked(anyUserExists).mockResolvedValueOnce(false);
    await expect(authHandler(fakeEvent('POST', '/auth/sign-up/email'))).rejects.toThrow('SENTINEL-gate-passed');
  });

  it('dot-segment sign-in POST still hits the password-disabled gate', async () => {
    await expect(authHandler(fakeEvent('POST', '/auth/sign-in/./email'))).rejects.toMatchObject({
      statusCode: 403,
      statusMessage: 'password login is disabled',
    });
  });

  it('dot-segment oauth2 probe still 404s when OIDC is off', async () => {
    await expect(authHandler(fakeEvent('GET', '/auth/oauth2/./callback'))).rejects.toMatchObject({
      statusCode: 404,
      statusMessage: 'OIDC not configured',
    });
  });

  it('GET is never sign-up-gated', async () => {
    await expect(authHandler(fakeEvent('GET', '/auth/sign-up/email'))).rejects.toThrow('SENTINEL-gate-passed');
  });
});
