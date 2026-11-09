// Employee write-surface text (#377, SPEC "API law" TEXT-STORABILITY LAW):
// Postgres text cannot store NUL or an unpaired surrogate, and the driver error
// would land as an opaque 500 on schema-legal input — every free-text employee
// field refuses such input at the schema edge instead. `title` and the AI
// extension fields share the exposure with `name`: they all land in text
// columns of the `user` / `ai_employees` / `employee_titles` inserts.

import { z } from 'zod';

import { hasUnstorableText } from '#shared/utils/storable-text';

const unstorableMessage = (field: string) => `${field} contains invalid characters (NUL or a lone surrogate)`;

/** non-blank, capped, storable text — the refused classes are unstorable, never silently rewritten */
export function storableText(field: string, max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !hasUnstorableText(v), unstorableMessage(field));
}

/** storable text for optional/nullable fields — callers add `.nullable().optional()` */
export function storableOptionalText(field: string, max: number) {
  return z
    .string()
    .max(max)
    .refine((v) => !hasUnstorableText(v), unstorableMessage(field));
}
