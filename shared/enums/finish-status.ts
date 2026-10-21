import type { ValuesOf } from './values-of';

export const FINISH_STATUS = {
  DONE: 'DONE',
  FAILED: 'FAILED',
} as const;
export type FinishStatus = ValuesOf<typeof FINISH_STATUS>;