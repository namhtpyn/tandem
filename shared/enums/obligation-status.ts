import type { ValuesOf } from './values-of';

export const OBLIGATION_STATUS = {
  PENDING: 'PENDING',
  FULFILLED: 'FULFILLED',
  CANCELLED: 'CANCELLED',
} as const;
export type ObligationStatus = ValuesOf<typeof OBLIGATION_STATUS>;
