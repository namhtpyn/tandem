// Mount better-auth under /auth/* (basePath /auth — handler gets the FULL original path).
import type { H3Event } from 'h3'
import { getAuth, resolveAuthPolicy, anyUserExists } from '../../utils/auth'

function headerValue(v: string | string[] | undefined): string | undefined {
  // node never delivers undefined header values; arrays collapse to first
  return Array.isArray(v) ? v[0] : v
}

function buildIncomingRequest(event: H3Event, body: ArrayBuffer | undefined): Request {
  const headers = event.node.req.headers
  const host = headers.host ?? 'localhost'
  const proto = headerValue(headers['x-forwarded-proto']) ?? 'http'
  const full = event.node.req.url ?? '/'

  const method = event.method
  const hasBody = method !== 'GET' && method !== 'HEAD' && body !== undefined && body.byteLength > 0
  return new Request(`${proto}://${host}${full}`, {
    method,
    headers: new Headers(Object.entries(headers).flatMap(([k, v]) =>
      v === undefined ? [] : Array.isArray(v) ? v.map(item => [k, item] as [string, string]) : [[k, v] as [string, string]],
    )),
    body: hasBody ? body : undefined,
    ...(hasBody ? { duplex: 'half' as const } : {}),
  })
}

export default defineEventHandler(async (event) => {
  const full = event.node.req.url ?? ''
  // public deployments: password sign-up closes after the first user claims the
  // instance. OIDC user creation is NOT gated (admin enabled the provider).
  if (event.method === 'POST' && full.includes('/auth/sign-up/email')) {
    if (await anyUserExists()) {
      throw createError({ statusCode: 403, statusMessage: 'sign-up is closed' })
    }
  }
  if (event.method === 'POST' && full.includes('/auth/sign-in/email')) {
    const { passwordEnabled } = await resolveAuthPolicy()
    if (!passwordEnabled) {
      throw createError({ statusCode: 403, statusMessage: 'password login is disabled' })
    }
  }
  if (full.includes('/auth/oauth2/')) {
    const { oidcEnabled } = await resolveAuthPolicy()
    if (!oidcEnabled) {
      throw createError({ statusCode: 404, statusMessage: 'OIDC not configured' })
    }
  }

  const raw = event.method !== 'GET' && event.method !== 'HEAD'
    ? await readRawBody(event, false)
    : undefined

  let body: ArrayBuffer | undefined
  if (raw) {
    body = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer
  }

  const auth = await getAuth()
  const res = await auth.handler(buildIncomingRequest(event, body))

  res.headers.forEach((v, k) => setResponseHeader(event, k, v))
  setResponseStatus(event, res.status)
  if (res.body) {
    return new Uint8Array(await res.arrayBuffer())
  }
  return null
})
