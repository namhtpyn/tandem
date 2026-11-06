// Runtime key/value settings in Postgres (settings). Typed getters with
// defaults; OIDC providers live under key 'oidc_providers' as JSON.
import { and, eq, sql } from 'drizzle-orm';

import { parseFlags } from '#shared/flags';

import { asDb, db, type DbExecutor } from '../../db/index';
import { settings } from '../../db/schema';

export async function getSetting(key: string) {
  const row = await db.query.settings.findFirst({ columns: { value: true }, where: { key: { eq: key } } });
  return row?.value ?? null;
}

/** value + updatedAt in ONE row read — the snapshot a replace-style writer
 * renders from must not tear (a base minted from a different row version than
 * the entries it accompanies silently defeats the base check) */
export async function getSettingSnapshot(key: string): Promise<{ value: string | null; updatedAt: Date | null }> {
  const row = await db.query.settings.findFirst({
    columns: { value: true, updatedAt: true },
    where: { key: { eq: key } },
  });
  return { value: row?.value ?? null, updatedAt: row?.updatedAt ?? null };
}

/** CAS writer: commit only if the stored row's updatedAt still equals `base`
 * (ISO string; null = expect the key unset). One conditional statement — no
 * read-then-write window. Returns false when the base drifted or the row
 * appeared under a null base: the caller refuses instead of clobbering. */
export async function setSettingIfUnchanged(
  key: string,
  value: string,
  base: string | null,
  ex: DbExecutor = db,
): Promise<boolean> {
  const now = new Date();
  if (base === null) {
    // legal only if the key is STILL unset: insert-or-nothing is atomic
    const inserted = await asDb(ex)
      .insert(settings)
      .values({ key, value, updatedAt: now })
      .onConflictDoNothing({ target: settings.key })
      .returning({ key: settings.key });
    return inserted.length > 0;
  }
  const baseDate = new Date(base);
  if (Number.isNaN(baseDate.getTime())) return false;
  // compare at the precision the ISO base can express: the stored timestamptz
  // carries microseconds (postgres now() seeds) while the round-tripped ISO
  // string is ms-only — a bare equality matched nothing and refused EVERY
  // write on such rows (r6 e2e). date_trunc aligns both sides at ms.
  const rows = await asDb(ex)
    .update(settings)
    .set({ value, updatedAt: now })
    .where(and(eq(settings.key, key), sql`date_trunc('milliseconds', ${settings.updatedAt}) = ${baseDate}`))
    .returning({ key: settings.key });
  return rows.length > 0;
}

/** upsert one key; pass a tx to join the caller's transaction */
export async function setSetting(key: string, value: string, ex: DbExecutor = db) {
  const now = new Date();
  await asDb(ex)
    .insert(settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
}

/** delete one key; pass a tx to join the caller's transaction */
export async function deleteSetting(key: string, ex: DbExecutor = db) {
  await asDb(ex).delete(settings).where(eq(settings.key, key));
}

/** Default hard cap for one agent run (ACP turn); the Settings page overrides it. */
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;

/** The run timeout setting in ms; falls back to the 30 min default. The 1-min
 * minimum is enforced at the boundary (settings.update zod), not here. */
export async function getRunTimeoutMs() {
  const v = await getSetting('run_timeout_ms');
  const n = v === null ? Number.NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RUN_TIMEOUT_MS;
}

/** Default concurrent tasks allowed per agent; the Settings page overrides it. */
export const DEFAULT_TASKS_PER_AGENT = 1;

/** The tasks-per-agent setting; falls back to 1. The 1..32 range is enforced at
 * the boundary (settings.update zod), not here. */
export async function getTasksPerAgent() {
  const v = await getSetting('tasks_per_agent');
  const n = v === null ? Number.NaN : Number(v);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_TASKS_PER_AGENT;
}

/** The company prompt — prepended to EVERY agent brief (Settings page; 8k cap at the boundary). */
export async function getCompanyPrompt() {
  return ((await getSetting('company_prompt')) ?? '').trim();
}

/** One Workspace AI assignment: provider + optional model + vault key (internal use only). */
export type InternalAiAssignment = {
  providerId: string;
  model: string | null;
  keySecretId: string;
};

/** Parse one assignment; invalid JSON or a non-object yields null. Exported
 * for the settings integrity auditor — the corruption check must use the
 * reader's own parse, never a copy. */
export function parseAssignment(raw: string | null): InternalAiAssignment | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<InternalAiAssignment>;
    if (typeof v.providerId !== 'string' || v.providerId.length === 0) return null;
    if (typeof v.keySecretId !== 'string' || v.keySecretId.length === 0) return null;
    if (typeof v.model !== 'string' || v.model.length === 0) return null;
    return { providerId: v.providerId, model: v.model, keySecretId: v.keySecretId };
  } catch {
    return null;
  }
}

/** The stored feature-flag map (SPEC: Settings > Feature flags) — tolerant,
 * fail-closed: any invalid payload reads as {} (every flag off). */
export async function getFlags() {
  return parseFlags(await getSetting('flags'));
}

export async function getSettings() {
  const v = await getSetting('disablePasswordLogin');
  const name = await getSetting('companyName');
  const llm = parseAssignment(await getSetting('internal_llm'));
  const decision = parseAssignment(await getSetting('internal_decision'));
  return {
    disablePasswordLogin: v === 'true',
    companyName: name?.trim() || 'Tandem',
    internalLlm: llm,
    internalDecision: decision,
    runTimeoutMs: await getRunTimeoutMs(),
    tasksPerAgent: await getTasksPerAgent(),
    companyPrompt: await getCompanyPrompt(),
    flags: await getFlags(),
  };
}

export const INTERNAL_ASSIGNMENT_KEYS = { LLM: 'internal_llm', DECISION: 'internal_decision' } as const;
