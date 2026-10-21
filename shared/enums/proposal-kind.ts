import type { ValuesOf } from './values-of';

export const PROPOSAL_KIND = {
  SUBTASKS: 'SUBTASKS',
  REASSIGN: 'REASSIGN',
} as const;
export type ProposalKind = ValuesOf<typeof PROPOSAL_KIND>;
