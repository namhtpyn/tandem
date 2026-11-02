import type { ValuesOf } from './values-of';

export const RUN_STATUS = {
  RUNNING: 'RUNNING',
  DONE: 'DONE',
  FAILED: 'FAILED',
  /** STOP-RUN VERB (#229): settled by a human stop — not a verdict, the task is untouched */
  STOPPED: 'STOPPED',
} as const;
export type RunStatus = ValuesOf<typeof RUN_STATUS>;
export type FinishedStatus = Exclude<RunStatus, typeof RUN_STATUS.RUNNING>;
