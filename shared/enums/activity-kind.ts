import type { ValuesOf } from './values-of';

export const ACTIVITY_KIND = {
  QUESTION: 'QUESTION',
  ANSWER: 'ANSWER',
  FORWARD: 'FORWARD',
  NOTE: 'NOTE',
  VERDICT: 'VERDICT',
  STATUS: 'STATUS',
} as const;
export type ActivityKind = ValuesOf<typeof ACTIVITY_KIND>;
