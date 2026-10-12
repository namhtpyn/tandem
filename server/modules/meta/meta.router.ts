import { os } from '@orpc/server'
// version endpoint (public)
import { base } from '../kernel/kernel'

export const metaRouter = os.router({
  /** version — public */
  version: base.handler(() => ({ version: process.env.APP_VERSION || 'dev' })),
})
