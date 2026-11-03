import { createError, defineEventHandler, getRequestHeaders, getQuery, sendRedirect, setResponseStatus } from 'h3';

// GET /api/mcp/oauth/connect — OAuth per binding (#270 slice 2): admin-only
// browser redirect to the provider's authorize URL. Requires an existing
// binding on an oauth-configured registry entry; persists the single-use
// state row (PKCE S256, 10-minute TTL) whose id IS the authorization proof.
import { ROLE } from '#shared/enums';

import { buildServerContext } from '../../../../domains/kernel/context';
import { gateReadSession } from '../../../../domains/kernel/rest-gates';
import { startOauthConnect } from '../../../../domains/mcp/mcp-oauth.service';

export default defineEventHandler(async (event) => {
  const headers = new Headers();
  for (const [k, v] of Object.entries(getRequestHeaders(event))) headers.set(k, String(v));
  const session = await buildServerContext(headers).getSession();
  const gate = gateReadSession(session);
  if (!gate.ok) throw createError({ statusCode: gate.statusCode, statusMessage: gate.statusMessage });
  // admin verb (SPEC: bindings are written by admin verbs only) — the connect
  // flow mints authorization state, so it is a write in spirit
  if ((gate.session.user as { role?: string }).role !== ROLE.ADMIN) {
    throw createError({ statusCode: 403, statusMessage: 'insufficient role' });
  }
  const q = getQuery(event);
  const employeeId = typeof q.employeeId === 'string' ? q.employeeId : '';
  const serverId = typeof q.serverId === 'string' ? q.serverId : '';
  if (!employeeId || !serverId) {
    throw createError({ statusCode: 400, statusMessage: 'employeeId and serverId are required' });
  }
  const h = getRequestHeaders(event);
  const host =
    String(h['x-forwarded-host'] ?? h.host ?? 'localhost:3000')
      .split(',')[0]
      ?.trim() || 'localhost:3000';
  const proto =
    String(h['x-forwarded-proto'] ?? 'http')
      .split(',')[0]
      ?.trim() || 'http';
  try {
    const { authorizeUrl } = await startOauthConnect({ employeeId, serverId, origin: `${proto}://${host}` });
    return await sendRedirect(event, authorizeUrl);
  } catch (e) {
    setResponseStatus(event, 400);
    return e instanceof Error ? e.message : 'connect failed';
  }
});
