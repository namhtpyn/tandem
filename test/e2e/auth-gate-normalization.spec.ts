// Auth policy gates survive URL-normalization bypass shapes (audit #251).
// The instance under test always has users (auth.setup seeds them), so the
// sign-up closure gate is ACTIVE for every anonymous request. A raw-string
// gate once let `POST /auth/sign-up/./email` through while better-auth still
// served the endpoint (WHATWG pathname collapses dot segments). Pinned: every
// bypass shape is 403 `sign-up is closed`, and the wire-level direct shape
// stays 403 too. Anonymous context per the anon-context law (the request
// fixture inherits auth storage otherwise).
import { expect, test } from '@playwright/test';

const closed = 'sign-up is closed';
const probe = {
  data: { name: 'dot-segment-probe', email: 'dot-segment-probe@example.invalid', password: 'Str0ngPassw0rd!' },
};

test('dot-segment sign-up POST is gated on a closed instance', async ({ playwright }) => {
  const anon = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const res = await anon.post('/auth/sign-up/./email', probe);
    expect(res.status()).toBe(403);
    expect(await res.text()).toContain(closed);
  } finally {
    await anon.dispose();
  }
});

test('percent-encoded dot-segment shape is gated too', async ({ playwright }) => {
  const anon = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const res = await anon.post('/auth/sign-up/%2e%2e/sign-up/email', probe);
    expect(res.status()).toBe(403);
    expect(await res.text()).toContain(closed);
  } finally {
    await anon.dispose();
  }
});

test('direct sign-up POST stays gated (wire-level control)', async ({ playwright }) => {
  const anon = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const res = await anon.post('/auth/sign-up/email', probe);
    expect(res.status()).toBe(403);
    expect(await res.text()).toContain(closed);
  } finally {
    await anon.dispose();
  }
});
