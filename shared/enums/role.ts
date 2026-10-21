import type { ValuesOf } from './values-of';

export const ROLE = {
  ADMIN: 'ADMIN',
  EMPLOYEE: 'EMPLOYEE',
  VIEWER: 'VIEWER',
} as const;
export type Role = ValuesOf<typeof ROLE>;
