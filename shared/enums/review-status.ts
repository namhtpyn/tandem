import type { ValuesOf } from './values-of';

export const REVIEW_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  CHANGE_REQUESTED: 'CHANGE_REQUESTED',
  REJECTED: 'REJECTED',
  /** reviewer stepped aside — supervisor replaced them (audit row, never counts) */
  ESCALATED: 'ESCALATED',
  /** round torn down by a manual settle (audit row, never counts) */
  SUPERSEDED: 'SUPERSEDED',
} as const;
export type ReviewStatus = ValuesOf<typeof REVIEW_STATUS>;
