import type { ValuesOf } from './values-of';

export const REVIEW_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  CHANGE_REQUESTED: 'CHANGE_REQUESTED',
  REJECTED: 'REJECTED',
} as const;
export type ReviewStatus = ValuesOf<typeof REVIEW_STATUS>;
