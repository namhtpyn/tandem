// Runtime key/value settings in Postgres (settings). Typed getters with
// defaults; OIDC providers live under key 'oidc_providers' as JSON.
import { eq } from 'drizzle-orm';

import { db } from '../../db/index';
import { settings } from '../../db/schema';

export async function getSetting(key: string) {
  const row = await db.query.settings.findFirst({ columns: { value: true }, where: { key: { eq: key } } });
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string) {
  const now = new Date();
  await db
    .insert(settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
}

export async function deleteSetting(key: string) {
  await db.delete(settings).where(eq(settings.key, key));
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

export type AppSettings = {
  disablePasswordLogin: boolean;
  companyName: string;
  /** hard cap for one agent run (ms) */
  runTimeoutMs: number;
  /** concurrent tasks allowed per agent */
  tasksPerAgent: number;
  /** prepended to every agent brief */
  companyPrompt: string;
  /** LLM used by Tandem's own server-side features (null = unassigned). */
  internalLlm: InternalAiAssignment | null;
  /** Decision engine used for auto-assign (null = unassigned). */
  internalDecision: InternalAiAssignment | null;
};

/** Parse one assignment; invalid JSON or a non-object yields null. */
function parseAssignment(raw: string | null): InternalAiAssignment | null {
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
  };
}

export const INTERNAL_ASSIGNMENT_KEYS = { LLM: 'internal_llm', DECISION: 'internal_decision' } as const;
export type InternalAssignmentKey = (typeof INTERNAL_ASSIGNMENT_KEYS)[keyof typeof INTERNAL_ASSIGNMENT_KEYS];
