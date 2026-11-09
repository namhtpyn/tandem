// Employee write-surface text (#377, SPEC "API law" TEXT-STORABILITY LAW):
// Postgres text cannot store NUL or an unpaired surrogate. A NUL makes the
// driver throw (invalid byte sequence -> an opaque 500 on schema-legal input);
// an unpaired surrogate is rewritten to U+FFFD, so the stored value is
// silently corrupted. Every text field the employee writes store refuses both
// classes at the schema edge instead. `title`, the AI extension fields and the
// avatar data URL share the exposure with `name`: they all land in text
// columns of the `user` / `ai_employees` / `employee_titles` rows.

import { z } from 'zod';

import { hasUnstorableText } from '#shared/utils/storable-text';

const unstorableMessage = (field: string) => `${field} contains invalid characters (NUL or a lone surrogate)`;

/** non-blank, storable text — an omitted `max` keeps an already-uncapped field uncapped (text-typed ids) */
export function storableText(field: string, max?: number) {
  const base = z.string().min(1);
  return (max === undefined ? base : base.max(max)).refine((v) => !hasUnstorableText(v), unstorableMessage(field));
}

/** storable text for optional/nullable fields — callers add `.nullable().optional()` */
export function storableOptionalText(field: string, max: number) {
  return z
    .string()
    .max(max)
    .refine((v) => !hasUnstorableText(v), unstorableMessage(field));
}
