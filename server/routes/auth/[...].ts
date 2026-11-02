// Mount better-auth under /auth/* (basePath /auth — handler gets the FULL original path).
import {
  createError,
  defineEventHandler,
  getRequestHeaders,
  readRawBody,
  setResponseHeader,
  setResponseStatus,
} from 'h3';

import { getAuth, resolveAuthPolicy, anyUserExists } from '../../domains/auth/auth.service';
import { hasUndeclaredBodySize } from '../../domains/kernel/request-body';
import { buildForwardedRequest } from '../../domains/kernel/request-forward';
import { normalizedAuthPath } from '../../domains/kernel/request-path';

/** generous for JSON auth payloads, small enough that a hostile body cannot balloon memory */
const MAX_AUTH_BODY_BYTES = 1_000_000;

export default defineEventHandler(async (event) => {
  const full = event.node.req.url ?? '';
  // gates match the ROUTER's path shape, not the raw url: better-auth routes on
  // the WHATWG-normalized pathname, which collapses /./ and /../ — gating on the
  // raw string let `POST /auth/sign-up/./email` bypass the closure gate entirely
  // while the endpoint still served (audit #251)
  const authPath = normalizedAuthPath(full);
  // undeclared-length (chunked) bodies: h3 buffers the whole body before the
  // 1MB cap can fire and the bun preset allows no mid-stream cap — refuse
  // before a byte is read (SPEC §Auth request-body law, audit #241)
  if (hasUndeclaredBodySize(getRequestHeaders(event))) {
    throw createError({ statusCode: 411, statusMessage: 'length required' });
  }
  // public deployments: password sign-up closes after the first user claims the
  // instance. OIDC user creation is NOT gated (admin enabled the provider).
  if (event.method === 'POST' && authPath.startsWith('/auth/sign-up/')) {
    if (await anyUserExists()) {
      throw createError({ statusCode: 403, statusMessage: 'sign-up is closed' });
    }
  }
  if (event.method === 'POST' && authPath.startsWith('/auth/sign-in/')) {
    const { passwordEnabled } = await resolveAuthPolicy();
    if (!passwordEnabled) {
      throw createError({ statusCode: 403, statusMessage: 'password login is disabled' });
    }
  }
  if (authPath.startsWith('/auth/oauth2/')) {
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
  const res = await auth.handler(buildForwardedRequest(event, body));

  for (const [k, v] of res.headers) setResponseHeader(event, k, v);
  setResponseStatus(event, res.status);
  if (res.body) {
    return new Uint8Array(await res.arrayBuffer());
  }
  return null;
});
