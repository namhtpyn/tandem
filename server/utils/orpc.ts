// COMPAT SHIM — the router now lives in server/domains/ (NestJS-style module
// structure). This file re-exports for existing test imports; new code imports
// from server/domains/app.router and server/domains/kernel/context.
export { appRouter as router } from '../domains/app.router'
export { buildServerContext } from '../domains/kernel/context'
export type { ServerContext } from '../domains/kernel/kernel'
export type { ChangeBusEvent } from '../domains/kernel/kernel'

// model cache (used by providers module + tests)
export { modelCache, MODEL_CACHE_TTL_MS, sweepModelCache } from '../domains/providers/models-cache'
