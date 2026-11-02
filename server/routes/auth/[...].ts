// Mount better-auth under /auth/* (basePath /auth — handler gets the FULL original path).
import {
  createError,
  defineEventHandler,
  getRequestHeaders,
  readRawBody,
  setResponseHeader,
  setResponseStatus,
} from 'h3';
import type { H3Event } from 'h3';

import { getAuth, resolveAuthPolicy, anyUserExists } from '../../domains/auth/auth.service';
import { hasUndeclaredBodySize } from '../../domains/kernel/request-body';

/** generous for JSON auth payloads, small enough that a hostile body cannot balloon memory */
const MAX_AUTH_BODY_BYTES = 1_000_000;

function headerValue(v: string | string[] | undefined): string | undefined {
  // node never delivers undefined header values; arrays collapse to first
  return Array.isArray(v) ? v[0] : v;
}

function buildIncomingRequest(event: H3Event, body: ArrayBuffer | undefined): Request {
  const headers = event.node.req.headers;
  const host = headers.host ?? 'localhost';
  const proto = headerValue(headers['x-forwarded-proto']) ?? 'http';
  const full = event.node.req.url ?? '/';

  const method = event.method;
  const hasBody = method !== 'GET' && method !== 'HEAD' && body !== undefined && body.byteLength > 0;
  return new Request(`${proto}://${host}${full}`, {
    method,
    headers: new Headers(
      Object.entries(headers).flatMap(([k, v]) =>
        v === undefined
          ? []
          : Array.isArray(v)
            ? v.map((item) => [k, item] as [string, string])
            : [[k, v] as [string, string]],
      ),
    ),
    body: hasBody ? body : undefined,
    ...(hasBody ? { duplex: 'half' as const } : {}),
  });
}

export default defineEventHandler(async (event) => {
  const full = event.node.req.url ?? '';
  // undeclared-length (chunked) bodies: h3 buffers the whole body before the
  // 1MB cap can fire and the bun preset allows no mid-stream cap — refuse
  // before a byte is read (SPEC §Auth request-body law, audit #241)
  if (hasUndeclaredBodySize(getRequestHeaders(event))) {
    throw createError({ statusCode: 411, statusMessage: 'length required' });
  }
  // public deployments: password sign-up closes after the first user claims the
  // instance. OIDC user creation is NOT gated (admin enabled the provider).
  if (event.method === 'POST' && full.includes('/auth/sign-up/email')) {
    if (await anyUserExists()) {
      throw createError({ statusCode: 403, statusMessage: 'sign-up is closed' });
    }
  }
  if (event.method === 'POST' && full.includes('/auth/sign-in/email')) {
    const { passwordEnabled } = await resolveAuthPolicy();
    if (!passwordEnabled) {
      throw createError({ statusCode: 403, statusMessage: 'password login is disabled' });
    }
  }
  if (full.includes('/auth/oauth2/')) {
    const { oidcEnabled } = await resolveAuthPolicy();
    if (!oidcEnabled) {
      throw createError({ statusCode: 404, statusMessage: 'OIDC not configured' });
    }
  }

  const raw = event.method !== 'GET' && event.method !== 'HEAD' ? await readRawBody(event, false) : undefined;
  // 1MB body cap before better-auth sees the bytes — auth bodies are tiny JSON; bigger is abuse
  // (declared bodies only: chunked was refused 411 above, so h3 never streams unbounded here)
  if (raw && Buffer.byteLength(raw) > MAX_AUTH_BODY_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'payload too large' });
  }

  let body: ArrayBuffer | undefined;
  if (raw) {
    body = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  }

  const auth = await getAuth();
  const res = await auth.handler(buildIncomingRequest(event, body));

  for (const [k, v] of res.headers) setResponseHeader(event, k, v);
  setResponseStatus(event, res.status);
  if (res.body) {
    return new Uint8Array(await res.arrayBuffer());
  }
  return null;
});
