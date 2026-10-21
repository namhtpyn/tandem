import type { ValuesOf } from './values-of';

export const PROPOSAL_STATUS = {
  PROPOSED: 'PROPOSED',
  EXECUTED: 'EXECUTED',
  REJECTED: 'REJECTED',
} as const;
export type ProposalStatus = ValuesOf<typeof PROPOSAL_STATUS>;
