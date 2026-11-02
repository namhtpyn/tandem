// ONE forwarded-Request builder for the body-carrying public adapters
// (/auth/**, /rpc): both consume the raw body via h3 first (SPEC request-body
// law — every cap fires pre-read), then rebuild a WHATWG Request from the
// checked bytes. Absolute URL from host/proto headers, collapsed header list,
// ArrayBuffer body (duplex: half is accepted with a non-stream body by the
// bun preset — proven in prod by /auth/**).
import type { H3Event } from 'h3';

function headerValue(v: string | string[] | undefined): string | undefined {
  // node never delivers undefined header values; arrays collapse to first
  return Array.isArray(v) ? v[0] : v;
}

export function buildForwardedRequest(event: H3Event, body: ArrayBuffer | undefined): Request {
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
