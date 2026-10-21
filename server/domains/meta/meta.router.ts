import { os } from '@orpc/server';
import { env } from '../kernel/env';

// version endpoint (public)
import { base } from '../kernel/kernel';

export const metaRouter = os.router({
  /** version — public */
  version: base.handler(() => ({ version: env.APP_VERSION ?? 'dev' })),
});
