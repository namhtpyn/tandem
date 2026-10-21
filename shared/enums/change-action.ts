import type { ValuesOf } from './values-of';

export const CHANGE_ACTION = {
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  REMOVE: 'REMOVE',
  DELETE: 'DELETE',
} as const;
export type ChangeAction = ValuesOf<typeof CHANGE_ACTION>;
