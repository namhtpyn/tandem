// Settings integrity audit (#123): the LIVE detector for settings corruption.
// Reads are tolerant and fail closed (SPEC: Settings & OIDC) — a corrupt value
// silently reads as its default, so tolerance alone cannot detect corruption.
// This module is the detect path: every KNOWN key's stored value is validated
// against the shape its write path produces. Consumers: the boot plugin (one
// log line) and /health/ready (503 while any known key is corrupt — SPEC:
// Health). Unknown keys pass — the namespace is extensible.
import { isValidFlagsPayload } from '#shared/flags';

import { db } from '../../db/index';
import { isValidStoredRegistry } from '../auth/oidc.service';
import { parseAssignment } from './settings.service';

export type CorruptSetting = { key: string; reason: string };

export type SettingsIntegrity = { ok: boolean; corrupt: CorruptSetting[] };

/** Validator for the stored form of `z.number().int().min(min).max(max)`:
 * settings numerics are stored as String(n). */
function intInRange(min: number, max: number): (raw: string) => string | null {
  return (raw: string): string | null => {
    const n = Number(raw);
    return Number.isInteger(n) && n >= min && n <= max ? null : `expected integer ${min}..${max}`;
  };
}

/** key -> validator. Each mirrors the settings.update zod shape
 * (settings.router) for the key's stored form — a value the update proc could
 * not have written is corruption by definition. */
const VALIDATORS: Record<string, (raw: string) => string | null> = {
  disablePasswordLogin: (raw) => (raw === 'true' || raw === 'false' ? null : "expected 'true' or 'false'"),
  run_timeout_ms: intInRange(60_000, 21_600_000),
  tasks_per_agent: intInRange(1, 32),
  company_prompt: (raw) => (raw.length <= 8000 ? null : 'over the 8000-char cap'),
  companyName: (raw) => (raw.trim().length >= 1 && raw.length <= 60 ? null : 'expected 1..60 chars'),
  flags: (raw) => (isValidFlagsPayload(raw) ? null : 'invalid flags payload'),
  internal_llm: (raw) => (parseAssignment(raw) === null ? 'invalid assignment JSON' : null),
  internal_decision: (raw) => (parseAssignment(raw) === null ? 'invalid assignment JSON' : null),
};

/** vault-bound validators (async: the registry blob is envelope-encrypted) */
const ASYNC_VALIDATORS: Record<string, (raw: string) => Promise<string | null>> = {
  oidc_providers: async (raw) => ((await isValidStoredRegistry(raw)) ? null : 'invalid OIDC registry'),
};

/** Validate every stored settings row; ok=false lists each corrupt key with
 * the reason. Never throws for a corrupt VALUE — only a db failure throws
 * (the readiness route's own error path handles that). */
export async function auditSettingsIntegrity(): Promise<SettingsIntegrity> {
  const rows = await db.query.settings.findMany({ columns: { key: true, value: true } });
  const corrupt: CorruptSetting[] = [];
  for (const row of rows) {
    const sync = VALIDATORS[row.key];
    if (sync) {
      const reason = sync(row.value);
      if (reason) corrupt.push({ key: row.key, reason });
      continue;
    }
    const asyncCheck = ASYNC_VALIDATORS[row.key];
    if (asyncCheck) {
      const reason = await asyncCheck(row.value);
      if (reason) corrupt.push({ key: row.key, reason });
    }
  }
  return { ok: corrupt.length === 0, corrupt };
}
