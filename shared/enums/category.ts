import type { ValuesOf } from './values-of';

/** Task-status categories — the workflow vocabulary (never the seeded uuids).
 *  A status row carries one of these in `category`; every gate, board column and
 *  colour mapping keys off it, so the list lives here once. */
export const CATEGORY = {
  BACKLOG: 'backlog',
  READY: 'ready',
  WORKING: 'working',
  PAUSED: 'paused',
  WAITING_ANSWER: 'waiting_answer',
  IN_REVIEW: 'in_review',
  DONE: 'done',
  CANCELLED: 'cancelled',
} as const;

export type Category = ValuesOf<typeof CATEGORY>;

/** ordered as the workflow runs — status-manager options and board fallbacks */
export const CATEGORIES: readonly Category[] = [
  CATEGORY.BACKLOG,
  CATEGORY.READY,
  CATEGORY.WORKING,
  CATEGORY.PAUSED,
  CATEGORY.WAITING_ANSWER,
  CATEGORY.IN_REVIEW,
  CATEGORY.DONE,
  CATEGORY.CANCELLED,
];
