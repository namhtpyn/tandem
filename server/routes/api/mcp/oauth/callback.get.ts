// GET /api/mcp/oauth/callback — OAuth per binding (#270 slice 2): the provider
// returns here with code + state. The single-use state row is the
// authorization proof (no session check — provider redirects are the only
// caller); the code is exchanged SERVER-side (client secret + PKCE verifier)
// and the binding's tokens are stored. Renders a close-this-window result
// page and notifies the opener (postMessage) so the agent editor refreshes.
import { defineEventHandler, getQuery, setResponseStatus } from 'h3';

import { handleOauthCallback } from '../../../../domains/mcp/mcp-oauth.service';

function resultPage(ok: boolean, detail: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MCP authorization</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh;margin:0;background:#0f1115;color:#e6e8ee}main{text-align:center;padding:2rem;max-width:32rem}h1{font-size:1.25rem}p{color:#9aa2b1;word-break:break-word}</style></head>
<body><main><h1>${ok ? 'Authorization complete' : 'Authorization failed'}</h1><p>${esc(detail)}</p><p><a href="/mcp" style="color:#7aa2f7">Back to MCP registry</a></p></main>
<script>try{window.opener&&window.opener.postMessage({type:'mcp-oauth',ok:${ok ? 'true' : 'false'}},window.location.origin)}catch(e){}</script>
</body></html>`;
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event);
  const code = typeof q.code === 'string' ? q.code : '';
  const state = typeof q.state === 'string' ? q.state : '';
  const error = typeof q.error === 'string' ? q.error : '';
  if (error) {
    setResponseStatus(event, 400);
    return resultPage(false, `provider returned ${error}`);
  }
  if (!code || !state) {
    setResponseStatus(event, 400);
    return resultPage(false, 'missing code or state');
  }
  try {
    await handleOauthCallback({ code, state });
    return resultPage(true, 'The MCP server is now authorized for this agent. You can close this window.');
  } catch (e) {
    setResponseStatus(event, 400);
    return resultPage(false, e instanceof Error ? e.message : 'token exchange failed');
  }
});
