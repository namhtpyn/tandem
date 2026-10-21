import { eq } from 'drizzle-orm';
// Model provider + model catalog (model_providers).
// API keys are NEVER stored here — per-agent in the vault (fleet law).


import { db } from '../../db';
import { modelProviders } from '../../db/schema';

export type ModelProviderRow = {
  id: string;
  label: string;
  baseUrl: string;
  /** set of API styles this endpoint speaks (validated against shared/api-styles.ts) */
  endpoints: string[];
  extraHeaders: Record<string, string> | null;
  notes: string | null;
};

export async function listModelProviders() {
  const provs = await db.query.modelProviders.findMany();
  return provs.map((p) => ({
    id: p.id,
    label: p.label,
    baseUrl: p.baseUrl,
    endpoints: p.endpoints as string[],
    extraHeaders: p.extraHeaders ? JSON.parse(p.extraHeaders) : null,
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
