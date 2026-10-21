import type { ValuesOf } from './values-of';

export const SECRET_USAGE = {
  SSH_KEY: 'SSH_KEY',
  PASSWORD: 'PASSWORD',
} as const;
export type SecretUsage = ValuesOf<typeof SECRET_USAGE>;
