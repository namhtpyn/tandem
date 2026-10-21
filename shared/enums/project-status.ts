import type { ValuesOf } from './values-of';

export const PROJECT_STATUS = {
  ACTIVE: 'ACTIVE',
  ARCHIVED: 'ARCHIVED',
} as const;
export type ProjectStatus = ValuesOf<typeof PROJECT_STATUS>;
