import { eq } from 'drizzle-orm';
// Credential origin resolution (SPEC "Roles & access"): better-auth's apiKey
// plugin fabricates the session for an x-api-key request with
// session.id = apiKey.id, so a session id that resolves to an `apikey` row is
// an AGENT credential — a human login always carries a `session` row id.
// Loaded lazily by the kernel middleware so the db chain only loads when a
// human-only procedure actually executes.

import { db } from '../../db/index';
import { apikey } from '../../db/schema';

/** true when the resolved session's id is an apikey row (agent credential) */
export async function isApiKeySession(sessionId: string | undefined): Promise<boolean> {
  if (!sessionId) return false;
  const rows = await db.select({ id: apikey.id }).from(apikey).where(eq(apikey.id, sessionId)).limit(1);
  return rows.length > 0;
}
