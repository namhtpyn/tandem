// /rpc request-body law (audit #252): caps fire BEFORE the oRPC handler
// buffers input — a declared body over the 2MB procedure-input cap is 413
// pre-decode; an undeclared chunked body is 411 before a byte is read (no
// pre-read bound exists on the bun preset); a legitimate envelope passes as
// the wire control. Anonymous context per the anon-context law — the request
// fixture inherits auth storage otherwise.
import http from 'node:http';

import { expect, test, type APIRequestContext } from '@playwright/test';

const baseURL = process.env.TANDEM_E2E_URL || 'http://localhost:4100';

async function anonContext(playwright: {
  request: { newContext(opts: object): Promise<APIRequestContext> };
}): Promise<APIRequestContext> {
  return playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
}

test('anonymous oversized declared POST is 413 before oRPC decodes input', async ({ playwright }) => {
  const anon = await anonContext(playwright);
  try {
    const big = JSON.stringify({ json: { blob: 'x'.repeat(2_000_000) } });
    const res = await anon.post('/rpc/meta/version', { data: big, headers: { 'content-type': 'application/json' } });
    expect(res.status()).toBe(413);
  } finally {
    await anon.dispose();
  }
});

test('undeclared chunked POST is 411 pre-read', async ({ playwright }) => {
  // playwright/undici always declare content-length — a raw node socket for
  // the chunked shape (tiny body: the 411 races nothing)
  const base = new URL(baseURL);
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        hostname: base.hostname,
        port: base.port || undefined,
        path: '/rpc/meta/version',
        method: 'POST',
        headers: { 'transfer-encoding': 'chunked', 'content-type': 'application/json' },
      },
      (res: http.IncomingMessage) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.write('{"json":null}');
    req.end();
  });
  expect(status).toBe(411);
});

test('legitimate envelope passes (wire control)', async ({ playwright }) => {
  const anon = await anonContext(playwright);
  try {
    const res = await anon.post('/rpc/meta/version', {
      data: { json: null },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('version');
  } finally {
    await anon.dispose();
  }
});
