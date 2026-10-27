import { eq } from 'drizzle-orm';
// Model provider + model catalog (model_providers).
// API keys are NEVER stored here — per-agent in the vault (fleet law).

import { ROLE, type Role } from '#shared/enums';

import { db } from '../../db/index';

export type ModelProviderRow = {
  id: string;
  label: string;
  baseUrl: string;
  /** set of API styles this endpoint speaks (validated against shared/api-styles.ts) */
  endpoints: string[];
  extraHeaders: Record<string, string> | null;
  notes: string | null;
};

export async function listModelProviders(callerRole?: Role) {
  const provs = await db.query.modelProviders.findMany({
    columns: { id: true, label: true, baseUrl: true, endpoints: true, extraHeaders: true, notes: true },
    orderBy: { label: 'asc' },
  });
  // extra headers can carry tenant/router credentials — admin eyes only, so a
  // caller with no known role fails closed
  const isAdmin = callerRole === ROLE.ADMIN;
  return provs.map((p) => ({
    id: p.id,
    label: p.label,
    baseUrl: p.baseUrl,
    endpoints: p.endpoints as string[],
    extraHeaders: isAdmin && p.extraHeaders ? JSON.parse(p.extraHeaders) : null,
    notes: p.notes,
  }));
}

export async function providerInUse(providerId: string) {
  const { aiEmployees } = await import('../../db/schema');
  const rows = await db
    .select({ userId: aiEmployees.userId })
    .from(aiEmployees)
    .where(eq(aiEmployees.providerId, providerId));
  return rows.length > 0;
}
