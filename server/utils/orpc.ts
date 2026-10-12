// COMPAT SHIM — the router now lives in server/modules/ (NestJS-style module
// structure). This file re-exports for existing test imports; new code imports
// from server/modules/app.router and server/modules/kernel/context.
export { appRouter as router } from '../modules/app.router'
export { buildServerContext } from '../modules/kernel/context'
export type { ServerContext } from '../modules/kernel/kernel'
export type { ChangeBusEvent } from '../modules/kernel/kernel'

// model cache (used by providers module + tests)
export { modelCache, MODEL_CACHE_TTL_MS, sweepModelCache } from '../modules/providers/models-cache'
