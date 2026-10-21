import type { ValuesOf } from './values-of';

export const OBLIGATION_ROLE = {
  ANSWER: 'ANSWER',
  APPROVAL: 'APPROVAL',
} as const;
export type ObligationRole = ValuesOf<typeof OBLIGATION_ROLE>;
