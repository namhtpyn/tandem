import type { ValuesOf } from './values-of';

export const CHANGE_RESOURCE = {
  ENVIRONMENTS: 'ENVIRONMENTS',
  SETTINGS: 'SETTINGS',
  OIDC: 'OIDC',
  PROVIDERS: 'PROVIDERS',
  PROJECTS: 'PROJECTS',
  EMPLOYEES: 'EMPLOYEES',
  TASKS: 'TASKS',
  TASK_ACTIVITY: 'TASK_ACTIVITY',
  STATUSES: 'STATUSES',
  RUNS: 'RUNS',
  VAULT: 'VAULT',
} as const;
export type ChangeResource = ValuesOf<typeof CHANGE_RESOURCE>;
